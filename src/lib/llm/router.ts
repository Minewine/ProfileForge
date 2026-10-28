import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { redact } from "@/lib/api/errors";
import { mapOpenRouterStatus } from "@/lib/llm/errors";
import { checkRunCap, recordUsage } from "@/lib/llm/usage";
import { modelSupportsStructuredOutputs } from "@/lib/settings/models";
import { requireKey } from "@/lib/settings/keyStore";
import { getSettings } from "@/lib/settings/store";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type TaskTier = "economy" | "premium";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type TaskDefinition<P = unknown, O = unknown> = {
  name: string;
  tier: TaskTier;
  outputSchema: z.ZodType<O>;
  inputSchema?: z.ZodType<P>;
  buildPrompt: (payload: P) => ChatMessage[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, TaskDefinition<any, any>>();

export function registerTask(def: TaskDefinition) {
  registry.set(def.name, def);
}

export function resetTaskRegistry() {
  registry.clear();
}

export type CallResult<O> = {
  data: O;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  modelUsed: string;
};

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REPAIR_RETRIES = 2;

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model?: string;
};

export async function callLLM<O = unknown>(args: {
  userId: string;
  task: string;
  payload: unknown;
  runId?: string;
  model?: string;
}): Promise<CallResult<O>> {
  const task = registry.get(args.task);
  if (!task) {
    throw new ApiError(
      "TASK_NOT_IMPLEMENTED",
      `LLM task "${args.task}" is not implemented in this slice.`,
    );
  }
  if (task.inputSchema) {
    const parsed = task.inputSchema.safeParse(args.payload);
    if (!parsed.success) {
      throw new ApiError("VALIDATION_ERROR", `Invalid payload for task ${args.task}.`, parsed.error.issues);
    }
  }

  const apiKey = await requireKey(args.userId);
  const settings = await getSettings(args.userId);
  const model = args.model ?? (task.tier === "economy" ? settings.modelEconomy : settings.modelPremium);
  const runId = args.runId ?? `run-${crypto.randomUUID()}`;

  await checkRunCap(runId, args.userId);

  const baseMessages = task.buildPrompt(args.payload);
  const jsonSchema = z.toJSONSchema(task.outputSchema) as Record<string, unknown>;

  // Models without native structured-output support (e.g. free-tier picks like
  // minimax/minimax-m3.1-flash:free) must not receive response_format /
  // require_parameters — OpenRouter would reject the routing. We degrade to
  // prompt-only JSON; local zod validation + repair retries still enforce the
  // contract (R4).
  const useStructured = await modelSupportsStructuredOutputs(model);

  const messages = [...baseMessages];
  if (!useStructured) {
    messages.push({
      role: "system",
      content: `Respond ONLY with a single JSON object (no prose, no code fences) that strictly matches this JSON Schema:\n${JSON.stringify(jsonSchema)}`,
    });
  }
  let lastUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= MAX_REPAIR_RETRIES; attempt++) {
    const body: Record<string, unknown> = { model, messages };
    if (useStructured) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: task.name, strict: true, schema: jsonSchema },
      };
      body.provider = { require_parameters: true };
    }

    const { response, rawContent } = await postWithRetry(apiKey, body);
    const usage = response.usage ?? {};
    lastUsage = {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      costUsd: usage.cost ?? 0,
    };

    const parsedJson = parseJsonContent(rawContent);
    if (parsedJson === null) {
      messages.push(
        { role: "assistant", content: String(rawContent).slice(0, 4000) },
        {
          role: "user",
          content:
            "Your previous response was not valid JSON. Return ONLY a JSON object matching the schema — no prose, no code fences.",
        },
      );
      continue;
    }

    const validated = task.outputSchema.safeParse(parsedJson);
    if (validated.success) {
      await recordUsage(
        {
          task: task.name,
          model: response.model ?? model,
          runId,
          ...lastUsage,
          durationMs: Date.now() - startedAt,
        },
        args.userId,
      );
      return {
        data: validated.data as O,
        usage: lastUsage,
        modelUsed: response.model ?? model,
      };
    }

    const issues = validated.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .slice(0, 10)
      .join("; ");
    messages.push(
      { role: "assistant", content: JSON.stringify(parsedJson).slice(0, 4000) },
      {
        role: "user",
        content: `Your previous response failed schema validation: ${issues}. Return ONLY a corrected JSON object matching the schema.`,
      },
    );
  }

  throw new ApiError(
    "LLM_SCHEMA_REPAIR_FAILED",
    "The model repeatedly returned unusable output. Retry, or switch to a different model in Settings.",
  );
}

async function postWithRetry(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ response: OpenRouterResponse; rawContent: unknown }> {
  let lastError: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = mapOpenRouterStatus(res.status);
        if ((res.status === 429 || res.status >= 500) && i === 0) {
          await sleep(2000);
          continue;
        }
        // FR-002 (feature 006): retain the provider's failure detail server-side
        // for diagnosis — status + a short body snippet, secrets redacted, never
        // the key/prompt/full response. The user-facing message stays generic.
        // Read after the retry decision: the body is consumed exactly once, on
        // the attempt that actually throws.
        const detail = await res.text().catch(() => "");
        console.warn(redact(`openrouter ${body.model} call failed: HTTP ${res.status} ${detail.slice(0, 200)}`));
        throw err;
      }
      const response = (await res.json()) as OpenRouterResponse;
      const rawContent = response.choices?.[0]?.message?.content ?? null;
      if (rawContent === null) {
        throw new ApiError("LLM_UNAVAILABLE", "The AI provider returned an empty response. Please retry.");
      }
      return { response, rawContent };
    } catch (e) {
      lastError = e;
      if (e instanceof ApiError) throw e;
      // network/timeout: one retry
      if (i === 0) {
        await sleep(1000);
        continue;
      }
    }
  }
  throw new ApiError(
    "LLM_UNAVAILABLE",
    `The AI provider could not be reached. Please retry. (${redact(String(lastError))})`,
  );
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content === "object" && content !== null) return content;
  if (typeof content !== "string") return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
