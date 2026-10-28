import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@/lib/api/errors";
import { registeredTaskTier } from "@/lib/llm/registry";
import { getLlmTransport, setLlmTransport, type LlmTransport } from "@/lib/llm/transport";
import { getSettings } from "@/lib/settings/store";

/**
 * Pinned AI transcripts for keyless benchmark runs (spec 009 US5, research D4):
 * record = live call + append; replay = serve the pinned response for an exact
 * (payload, model) match — a miss is a loud TRANSCRIPT_MISS, never a synthesis.
 */

export type TranscriptEntry = {
  inputHash: string;
  model: string;
  response: unknown;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
};

/** Key-order-independent JSON (hashes must not depend on object key order). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function transcriptInputHash(payload: unknown, model: string): string {
  return createHash("sha256").update(`${stableStringify(payload)}\0${model}`).digest("hex");
}

export class TranscriptStore {
  private readonly cache = new Map<string, TranscriptEntry[]>();

  constructor(readonly rootDir: string) {}

  private fileFor(fixtureSetVersion: string, taskId: string): string {
    return join(this.rootDir, fixtureSetVersion, `${taskId}.jsonl`);
  }

  record(fixtureSetVersion: string, taskId: string, entry: TranscriptEntry): void {
    const file = this.fileFor(fixtureSetVersion, taskId);
    mkdirSync(join(this.rootDir, fixtureSetVersion), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
    this.cache.delete(file);
  }

  lookup(fixtureSetVersion: string, taskId: string, inputHash: string): TranscriptEntry | null {
    const file = this.fileFor(fixtureSetVersion, taskId);
    let entries = this.cache.get(file);
    if (!entries) {
      if (!existsSync(file)) return null;
      entries = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TranscriptEntry);
      this.cache.set(file, entries);
    }
    return entries.find((e) => e.inputHash === inputHash) ?? null;
  }
}

/** Live call + transcript append (used with `--record`). */
export function makeRecordingTransport(inner: LlmTransport, store: TranscriptStore, fixtureSetVersion: string): LlmTransport {
  return {
    async execute(req) {
      const result = await inner.execute(req);
      store.record(fixtureSetVersion, req.task, {
        inputHash: transcriptInputHash(req.payload, result.modelUsed),
        model: result.modelUsed,
        response: result.data,
        usage: result.usage,
      });
      return result;
    },
  };
}

/**
 * Replay pinned responses without credentials. The expected model is resolved
 * exactly as the live transport would (explicit override → task tier from the
 * caller's settings) so the input hash matches what was recorded.
 */
export function makeReplayTransport(store: TranscriptStore, fixtureSetVersion: string): LlmTransport {
  return {
    async execute(req) {
      const settings = await getSettings(req.userId);
      const tier = registeredTaskTier(req.task);
      const model =
        req.model ??
        (tier === "premium" ? settings.modelPremium : tier === "economy" ? settings.modelEconomy : undefined);
      if (model === undefined) {
        throw new ApiError("TRANSCRIPT_MISS", `Task "${req.task}" is not registered — cannot resolve its pinned transcript.`);
      }
      const hash = transcriptInputHash(req.payload, model);
      const entry = store.lookup(fixtureSetVersion, req.task, hash);
      if (!entry) {
        throw new ApiError(
          "TRANSCRIPT_MISS",
          `No pinned transcript for task "${req.task}" (input ${hash.slice(0, 8)}). ` +
            `Record one with --record using the same model mapping (${model}).`,
        );
      }
      return { data: entry.response, usage: entry.usage, modelUsed: entry.model };
    },
  };
}

/** Point the router at the benchmark transport; resetTransport() restores live. */
export function useBenchmarkTransport(transport: LlmTransport): void {
  setLlmTransport(transport);
}

export function resetTransport(): void {
  setLlmTransport(null);
}

/** Convenience for the CLI: transport for the requested benchmark mode. */
export function benchmarkTransport(
  mode: "record" | "replay",
  store: TranscriptStore,
  fixtureSetVersion: string,
): LlmTransport {
  return mode === "replay"
    ? makeReplayTransport(store, fixtureSetVersion)
    : makeRecordingTransport(getLlmTransport(), store, fixtureSetVersion);
}
