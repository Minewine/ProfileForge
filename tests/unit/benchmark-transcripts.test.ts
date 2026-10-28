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
  transcriptRequestIdentity,
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

describe("canonical claim keys for keyed tasks (cross-run replay)", () => {
  const requestA = {
    outputLanguage: "en",
    plan: [
      { key: "exp.cuid_run1_1.1", kind: "experience", sourceText: ["Led 5 engineers"], entryMeta: { title: "T", company: "C", dates: "2020 – 2022" } },
      { key: "exp.cuid_run1_1.2", kind: "experience", sourceText: ["Shipped p95"], entryMeta: { title: "T", company: "C", dates: "2020 – 2022" } },
    ],
    skills: ["Go"],
    summarySources: [],
    summaryRequirements: [],
    summaryMaxWords: 60,
    jdDigest: { keywords: ["Go"] },
    pageBudget: 2,
  };
  // a different run: same content, fresh cuids
  const requestB = {
    ...requestA,
    plan: requestA.plan.map((i) => ({ ...i, key: i.key.replace("cuid_run1", "cuid_run2") })),
  };

  it("hashes keyed payloads by canonical position, not by the embedded ids", () => {
    expect(transcriptRequestIdentity("generateTailoredCV", requestA, "m")).toBe(
      transcriptRequestIdentity("generateTailoredCV", requestB, "m"),
    );
    // non-keyed tasks keep exact-payload identity
    expect(transcriptRequestIdentity("extractRequirements", { text: "x", language: "en" }, "m")).toBe(
      transcriptInputHash({ text: "x", language: "en" }, "m"),
    );
  });

  it("semanticProposals: digest ids canonicalize positionally; entryIds materialize back", async () => {
    registerTask({
      name: "semanticProposals",
      tier: "economy",
      inputSchema: { parse: (v: unknown) => v } as never,
      outputSchema: { parse: (v: unknown) => v } as never,
      buildPrompt: () => [{ role: "system", content: "test" }],
    });
    const store = new TranscriptStore(mkdtempSync(join(tmpdir(), "pf-bench-digest-")));
    const version = "fixver1";
    const requestA = {
      language: "en",
      requirements: [{ text: "Kubernetes" }],
      profileDigest: [
        { id: "cuid_digest_1", type: "skill", text: "Kubernetes" },
        { id: "cuid_digest_2", type: "bullet", text: "Operated clusters" },
      ],
    };
    const requestB = {
      ...requestA,
      profileDigest: [
        { id: "cuid_other_1", type: "skill", text: "Kubernetes" },
        { id: "cuid_other_2", type: "bullet", text: "Operated clusters" },
      ],
    };
    const inner = {
      execute: vi.fn().mockResolvedValue({
        data: { proposals: [{ requirementIndex: 0, entryIds: ["cuid_digest_2", "cuid_digest_1"], rationale: "r" }] },
        usage,
        modelUsed: "m",
      }),
    };
    const recording = makeRecordingTransport(inner, store, version);
    await recording.execute({ userId: "u", task: "semanticProposals", payload: requestA, runId: "r1", model: "m" });

    const replay = makeReplayTransport(store, version);
    const result = await replay.execute({ userId: "u", task: "semanticProposals", payload: requestB, runId: "r2", model: "m" });
    const data = result.data as { proposals: Array<{ entryIds: string[] }> };
    // entryIds materialized onto run-2's digest ids, preserving order
    expect(data.proposals).toEqual([{ requirementIndex: 0, entryIds: ["cuid_other_2", "cuid_other_1"], rationale: "r" }]);
  });

  it("record → replay round-trips a keyed response onto the CURRENT run's keys", async () => {
    registerTask({
      name: "generateTailoredCV",
      tier: "premium",
      inputSchema: { parse: (v: unknown) => v } as never,
      outputSchema: { parse: (v: unknown) => v } as never,
      buildPrompt: () => [{ role: "system", content: "test" }],
    });
    const store = new TranscriptStore(mkdtempSync(join(tmpdir(), "pf-bench-keyed-")));
    const version = "fixver1";
    const inner = {
      execute: vi.fn().mockResolvedValue({
        data: {
          summary: "s",
          items: [
            { key: "exp.cuid_run1_1.2", text: "second" },
            { key: "exp.cuid_run1_1.1", text: "first" },
            { key: "exp.cuid_unknown.9", text: "unkeyed junk" },
          ],
          uncertainTranslations: [{ key: "exp.cuid_run1_1.1", note: "n" }],
        },
        usage,
        modelUsed: "m",
      }),
    };
    const recording = makeRecordingTransport(inner, store, version);
    await recording.execute({ userId: "u", task: "generateTailoredCV", payload: requestA, runId: "r1", model: "m" });
    // stored response carries positional keys, not the recording run's cuids
    const stored = JSON.parse(readFileSync(join(store.rootDir, version, "generateTailoredCV.jsonl"), "utf8").trim());
    expect(stored.response.items.map((i: { key: string }) => i.key)).toEqual(["#1", "#0", "exp.cuid_unknown.9"]);

    const replay = makeReplayTransport(store, version);
    const result = await replay.execute({ userId: "u", task: "generateTailoredCV", payload: requestB, runId: "r2", model: "m" });
    expect(result.modelUsed).toBe("m");
    const data = result.data as { items: Array<{ key: string; text: string }>; uncertainTranslations: Array<{ key: string }> };
    // positional keys are materialized onto run-2's keys; unknown keys pass through
    expect(data.items).toEqual([
      { key: "exp.cuid_run2_1.2", text: "second" },
      { key: "exp.cuid_run2_1.1", text: "first" },
      { key: "exp.cuid_unknown.9", text: "unkeyed junk" },
    ]);
    expect(data.uncertainTranslations).toEqual([{ key: "exp.cuid_run2_1.1", note: "n" }]);
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
