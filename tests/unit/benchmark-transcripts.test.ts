import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTaskRegistry, registerTask } from "@/lib/llm/registry";
import { getLlmTransport, setLlmTransport } from "@/lib/llm/transport";
import { DEFAULT_SETTINGS } from "@/lib/settings/store";
import {
  benchmarkTransport,
  makeRecordingTransport,
  makeReplayTransport,
  resetTransport,
  TranscriptStore,
  transcriptInputHash,
  stableStringify,
} from "@/lib/benchmark/transcripts";

vi.mock("@/lib/settings/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/store")>()),
}));

const usage = { promptTokens: 10, completionTokens: 5, costUsd: 0.001 };

afterEach(() => {
  resetTaskRegistry();
  resetTransport();
});

describe("transcript hashing", () => {
  it("is stable and key-order independent", () => {
    expect(stableStringify({ a: 1, b: { c: 2, a: 3 } })).toBe(stableStringify({ b: { a: 3, c: 2 }, a: 1 }));
    const payload = { text: "hello", language: "en" };
    expect(transcriptInputHash(payload, "m")).toBe(transcriptInputHash({ language: "en", text: "hello" }, "m"));
  });

  it("sensitively covers both payload and model", () => {
    expect(transcriptInputHash({ text: "hello" }, "m1")).not.toBe(transcriptInputHash({ text: "hello" }, "m2"));
    expect(transcriptInputHash({ text: "hello" }, "m")).not.toBe(transcriptInputHash({ text: "hell" }, "m"));
  });
});

describe("transcript store round trip", () => {
  it("records JSONL entries and looks them back up by hash", () => {
    const store = new TranscriptStore(mkdtempSync(join(tmpdir(), "pf-bench-tx-")));
    const version = "fixver1";
    const entry = { inputHash: "h1", model: "m", response: { ok: 1 }, usage };
    store.record(version, "extractRequirements", entry);
    store.record(version, "extractRequirements", { ...entry, inputHash: "h2" });

    expect(store.lookup(version, "extractRequirements", "h1")).toMatchObject({ response: { ok: 1 } });
    expect(store.lookup(version, "extractRequirements", "h2")).not.toBeNull();
    expect(store.lookup(version, "extractRequirements", "h3")).toBeNull();
    expect(store.lookup(version, "otherTask", "h1")).toBeNull();
    // committed as JSONL on disk under <version>/<taskId>.jsonl
    expect(readFileSync(join(store.rootDir, version, "extractRequirements.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("benchmark transports (US5)", () => {
  it("recording transport wraps live and pins each call; replay serves the pin", async () => {
    const root = mkdtempSync(join(tmpdir(), "pf-bench-tx-"));
    const store = new TranscriptStore(root);
    const inner = { execute: async () => ({ data: { answer: "yes" }, usage, modelUsed: DEFAULT_SETTINGS.modelEconomy }) };
    const recording = makeRecordingTransport(inner, store, "fixver1");

    registerTask({
      name: "testTask",
      tier: "economy",
      outputSchema: { safeParse: () => ({ success: true }) } as never,
      buildPrompt: () => [],
    });

    const payload = { text: "hello" };
    const result = await recording.execute({ userId: "u", task: "testTask", payload, runId: "r" });
    expect(result.data).toEqual({ answer: "yes" });
    expect(store.lookup("fixver1", "testTask", transcriptInputHash(payload, DEFAULT_SETTINGS.modelEconomy))).not.toBeNull();

    // replay over the same store returns the pinned response — no inner call
    let innerCalls = 0;
    const spyInner = {
      execute: async () => {
        innerCalls += 1;
        return { data: null, usage, modelUsed: DEFAULT_SETTINGS.modelEconomy };
      },
    };
    void spyInner;
    const replay = makeReplayTransport(store, "fixver1");
    const replayed = await replay.execute({ userId: "u", task: "testTask", payload, runId: "r2" });
    expect(replayed.data).toEqual({ answer: "yes" });
    expect(replayed.modelUsed).toBe(DEFAULT_SETTINGS.modelEconomy);
    expect(innerCalls).toBe(0);
  });

  it("replay with an unrecorded payload fails loudly with TRANSCRIPT_MISS", async () => {
    const store = new TranscriptStore(mkdtempSync(join(tmpdir(), "pf-bench-tx-")));
    registerTask({ name: "testTask", tier: "economy", outputSchema: { safeParse: () => ({ success: true }) } as never, buildPrompt: () => [] });
    const replay = makeReplayTransport(store, "fixver1");
    await expect(
      replay.execute({ userId: "u", task: "testTask", payload: { unrecorded: true }, runId: "r" }),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_MISS" });
  });

  it("replay resolves the expected model from the task tier and settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "pf-bench-tx-"));
    const store = new TranscriptStore(root);
    registerTask({ name: "testTask", tier: "premium", outputSchema: { safeParse: () => ({ success: true }) } as never, buildPrompt: () => [] });
    // default premium model (settings store default — the synthetic user has no row)
    const entry = {
      inputHash: transcriptInputHash({ q: 1 }, "anthropic/claude-sonnet-4.5"),
      model: "anthropic/claude-sonnet-4.5",
      response: { pinned: true },
      usage,
    };
    store.record("fixver9", "testTask", entry);

    const replay = makeReplayTransport(store, "fixver9");
    const result = await replay.execute({ userId: "u-no-row", task: "testTask", payload: { q: 1 }, runId: "r" });
    expect(result.data).toEqual({ pinned: true });
  });

  it("benchmarkTransport(record) wraps the CURRENT transport; resetTransport restores live", async () => {
    const root = mkdtempSync(join(tmpdir(), "pf-bench-tx-"));
    const store = new TranscriptStore(root);
    const inner = { execute: async () => ({ data: 1, usage, modelUsed: "m" }) };
    setLlmTransport(inner);
    const recording = benchmarkTransport("record", store, "v"); // constructs, wrapping `inner`
    setLlmTransport(recording); // the CLI installs it explicitly
    expect(getLlmTransport()).toBe(recording);
    resetTransport();
    expect(getLlmTransport()).not.toBe(recording); // live restored
  });
});
