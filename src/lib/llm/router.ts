import { ApiError } from "@/lib/api/errors";
import { getLlmTransport } from "@/lib/llm/transport";
import { getTaskDefinition, type ChatMessage, type TaskDefinition, type TaskTier } from "@/lib/llm/registry";

export { registerTask, resetTaskRegistry } from "@/lib/llm/registry";
export { OPENROUTER_URL } from "@/lib/llm/transport";
export type { ChatMessage, TaskDefinition, TaskTier };

export type CallResult<O = unknown> = {
  data: O;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  modelUsed: string;
};

/**
 * Route an LLM task: registry lookup + payload validation, then dispatch to the
 * active transport (live by default; the benchmark swaps in record/replay —
 * spec 009 US5). The default transport IS the historical execution path, moved
 * verbatim into src/lib/llm/transport.ts.
 */
export async function callLLM<O = unknown>(args: {
  userId: string;
  task: string;
  payload: unknown;
  runId?: string;
  model?: string;
}): Promise<CallResult<O>> {
  const task = getTaskDefinition(args.task);
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

  const runId = args.runId ?? `run-${crypto.randomUUID()}`;
  const result = await getLlmTransport().execute({
    userId: args.userId,
    task: args.task,
    payload: args.payload,
    runId,
    model: args.model,
  });
  return { data: result.data as O, usage: result.usage, modelUsed: result.modelUsed };
}
