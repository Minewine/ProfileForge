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

// --- Canonical id references for cross-run replay ---
//
// Several task payloads embed per-run database ids (the benchmark database is
// reset per run ⇒ fresh cuids), so a raw payload hash can never replay across
// runs: the keyed draft tasks' claim keys ("exp.<cuid>.1") and the
// semantic-proposals digest's entry ids. Hashing and storage canonicalize those
// id references to their positional index ("#0", "#1", …) within the request
// list they belong to; replay materializes them back onto the current run's
// ids. Content-preserving: the model's actual prompt keeps the real ids — only
// the transcript identity is canonical.

type CanonicalSpec = {
  /** The payload list whose id references are canonicalized positionally. */
  requestField: string;
  requestIdField: string;
  /** Response lists carrying references back into the request list: a scalar
   *  id field (`idField`) and/or an array-of-ids field (`idsInField`). */
  response: Array<{ field: string; idField?: string; idsInField?: string }>;
};

const CANONICAL_SPECS: Record<string, CanonicalSpec> = {
  generateTailoredCV: {
    requestField: "plan",
    requestIdField: "key",
    response: [
      { field: "items", idField: "key" },
      { field: "uncertainTranslations", idField: "key" },
    ],
  },
  generateCoverLetter: {
    requestField: "paragraphs",
    requestIdField: "key",
    response: [
      { field: "paragraphs", idField: "key" },
      { field: "uncertainTranslations", idField: "key" },
    ],
  },
  semanticProposals: {
    requestField: "profileDigest",
    requestIdField: "id",
    response: [{ field: "proposals", idsInField: "entryIds" }],
  },
};

function requestIdsInOrder(task: string, payload: unknown): string[] | null {
  const spec = CANONICAL_SPECS[task];
  if (!spec) return null;
  const arr = (payload as Record<string, unknown>)?.[spec.requestField];
  if (!Array.isArray(arr)) return null;
  const ids = arr.map((item) => (item as Record<string, unknown>)?.[spec.requestIdField]);
  return ids.every((id) => typeof id === "string") ? (ids as string[]) : null;
}

/** Hash identity for a request: canonicalizable tasks hash the canonicalized payload. */
export function transcriptRequestIdentity(task: string, payload: unknown, model: string): string {
  const ids = requestIdsInOrder(task, payload);
  if (!ids) return transcriptInputHash(payload, model);
  const spec = CANONICAL_SPECS[task];
  const canonical = structuredClone(payload) as Record<string, unknown>;
  for (const [i, item] of (canonical[spec.requestField] as Array<Record<string, unknown>>).entries()) {
    item[spec.requestIdField] = `#${i}`;
  }
  return transcriptInputHash(canonical, model);
}

/** Response stored in the transcript: real id references → positional "#i"
 *  (references the request did not contain are kept verbatim — the caller
 *  drops them). */
function canonicalizeResponse(task: string, requestPayload: unknown, response: unknown): unknown {
  const ids = requestIdsInOrder(task, requestPayload);
  if (!ids) return response;
  const spec = CANONICAL_SPECS[task];
  const toCanonical = new Map(ids.map((id, i) => [id, `#${i}`]));
  const clone = structuredClone(response) as Record<string, unknown>;
  for (const out of spec.response) {
    const arr = clone?.[out.field];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (out.idField) {
        const id = (item as Record<string, unknown> | null)?.[out.idField];
        if (typeof id === "string" && toCanonical.has(id)) (item as Record<string, unknown>)[out.idField] = toCanonical.get(id);
      }
      if (out.idsInField) {
        const list = (item as Record<string, unknown> | null)?.[out.idsInField];
        if (Array.isArray(list)) {
          (item as Record<string, unknown>)[out.idsInField] = list.map((id) =>
            typeof id === "string" && toCanonical.has(id) ? toCanonical.get(id) : id,
          );
        }
      }
    }
  }
  return clone;
}

/** Pinned response served to the caller: "#i" → the current run's real id
 *  (positional references without a matching request entry are left as-is and
 *  dropped downstream, exactly like any other unresolvable reference). */
function materializeResponse(task: string, requestPayload: unknown, response: unknown): unknown {
  const ids = requestIdsInOrder(task, requestPayload);
  if (!ids) return response;
  const spec = CANONICAL_SPECS[task];
  const clone = structuredClone(response) as Record<string, unknown>;
  for (const out of spec.response) {
    const arr = clone?.[out.field];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const resolve = (id: unknown): unknown => {
        const match = typeof id === "string" ? /^#(\d+)$/.exec(id) : null;
        return match && ids[Number(match[1])] !== undefined ? ids[Number(match[1])] : id;
      };
      if (out.idField) {
        const id = (item as Record<string, unknown> | null)?.[out.idField];
        if (typeof id === "string") (item as Record<string, unknown>)[out.idField] = resolve(id);
      }
      if (out.idsInField) {
        const list = (item as Record<string, unknown> | null)?.[out.idsInField];
        if (Array.isArray(list)) {
          (item as Record<string, unknown>)[out.idsInField] = list.map(resolve);
        }
      }
    }
  }
  return clone;
}

export class TranscriptStore {
  private readonly cache = new Map<string, TranscriptEntry[]>();

  constructor(readonly rootDir: string) {}

  /** Per-case scoping (the runner sets this per fixture case): transcript files
   *  live under <version>/<scope>/<task>.jsonl. Without a scope, the legacy
   *  shared layout <version>/<task>.jsonl applies. Scoping prevents cases that
   *  share a JD from serving each other's pinned extractions (last-wins lookup
   *  is per file, and the two cases' extract payloads hash identically). */
  scope: string | null = null;

  private fileFor(fixtureSetVersion: string, taskId: string): string {
    return this.scope
      ? join(this.rootDir, fixtureSetVersion, this.scope, `${taskId}.jsonl`)
      : join(this.rootDir, fixtureSetVersion, `${taskId}.jsonl`);
  }

  record(fixtureSetVersion: string, taskId: string, entry: TranscriptEntry): void {
    const file = this.fileFor(fixtureSetVersion, taskId);
    mkdirSync(join(this.rootDir, fixtureSetVersion, ...(this.scope ? [this.scope] : [])), { recursive: true });
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
    // last matching entry wins: transcript files append across --record runs,
    // and a later recording of the same input supersedes earlier ones (the
    // keyed drafts of that run correspond to ITS extraction, not the first)
    return entries.findLast((e) => e.inputHash === inputHash) ?? null;
  }
}

/** Live call + transcript append (used with `--record`). */
export function makeRecordingTransport(inner: LlmTransport, store: TranscriptStore, fixtureSetVersion: string): LlmTransport {
  return {
    async execute(req) {
      const result = await inner.execute(req);
      store.record(fixtureSetVersion, req.task, {
        inputHash: transcriptRequestIdentity(req.task, req.payload, result.modelUsed),
        model: result.modelUsed,
        response: canonicalizeResponse(req.task, req.payload, result.data),
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
      const hash = transcriptRequestIdentity(req.task, req.payload, model);
      const entry = store.lookup(fixtureSetVersion, req.task, hash);
      if (!entry) {
        throw new ApiError(
          "TRANSCRIPT_MISS",
          `No pinned transcript for task "${req.task}" (input ${hash.slice(0, 8)}). ` +
            `Record one with --record using the same model mapping (${model}).`,
        );
      }
      return {
        data: materializeResponse(req.task, req.payload, entry.response),
        usage: entry.usage,
        modelUsed: entry.model,
      };
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
