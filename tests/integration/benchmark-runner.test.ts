import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchmarkConfig } from "@/lib/benchmark/config";
import { loadFixtureSet, type FixtureSet } from "@/lib/benchmark/fixtures";
import { assembleReport } from "@/lib/benchmark/report";
import { runBenchmarkSet } from "@/lib/benchmark/runner";

// The runner composes the shipped callLLM call sites; mock the router module the
// same way generations-api.test.ts does (no network, no credentials, no spend).
const callLLMMock = vi.hoisted(() => vi.fn());
const mockState = vi.hoisted(() => ({ failCV: false, costPerCall: 0 }));

// Identity-rewrite mock: echoes plan items verbatim under their keys (numbers and
// dates preserved, so downstream metrics and mutations have real material), a
// bounded summary, all-faithful fact-guard verdicts, and a fixed requirement set.
async function mockImpl(args: { task: string; payload: Record<string, unknown> }) {
  if (mockState.failCV && args.task === "generateTailoredCV") {
    throw new Error("mock: provider exploded");
  }
  const usage = { promptTokens: 10, completionTokens: 5, costUsd: mockState.costPerCall };
  const payload = args.payload;
  switch (args.task) {
    case "extractRequirements":
      return {
        data: {
          requirements: [
            { text: "Go", category: "skill", importance: "must", isHardConstraint: true },
            { text: "Kubernetes", category: "skill", importance: "must", isHardConstraint: true },
            { text: "PostgreSQL", category: "skill", importance: "must", isHardConstraint: false },
            { text: "Bachelor degree in Computer Science", category: "education", importance: "must", isHardConstraint: true },
            { text: "Kafka", category: "tool", importance: "nice", isHardConstraint: false },
          ],
        },
        usage,
        modelUsed: "mock",
      };
    case "semanticProposals":
      return { data: { proposals: [] }, usage, modelUsed: "mock" };
    case "generateTailoredCV": {
      const p = payload as {
        plan: Array<{ key: string; sourceText: string[] }>;
        summarySources: string[];
        summaryMaxWords: number;
      };
      const words = p.summarySources.join(" ").split(/\s+/).filter(Boolean);
      return {
        data: {
          summary: words.slice(0, Math.min(20, p.summaryMaxWords)).join(" "),
          items: p.plan.map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
        },
        usage,
        modelUsed: "mock",
      };
    }
    case "generateCoverLetter": {
      const p = payload as { paragraphs: Array<{ key: string; evidenceText: string[] }> };
      return {
        data: { paragraphs: p.paragraphs.map((par) => ({ key: par.key, text: par.evidenceText.join(" ") })) },
        usage,
        modelUsed: "mock",
      };
    }
    case "factGuard": {
      const p = payload as { claims: Array<{ claimId: string }> };
      return { data: { verdicts: p.claims.map((c) => ({ claimId: c.claimId, verdict: "supported" })) }, usage, modelUsed: "mock" };
    }
    default:
      throw new Error(`mock callLLM: unexpected task "${args.task}"`);
  }
}

vi.mock("@/lib/llm/router", () => ({
  callLLM: callLLMMock,
  registerTask: vi.fn(),
  resetTaskRegistry: vi.fn(),
  OPENROUTER_URL: "x",
}));

const FIXTURES = join(process.cwd(), "benchmarks", "fixtures");
const fixtureSet: FixtureSet = loadFixtureSet(FIXTURES);

function baseConfig(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
  return { mode: "live", models: {}, spendCapUsd: 1000, compare: false, updateBaseline: false, ...overrides };
}

const METRIC_IDS = [
  "requirement_coverage",
  "selection_integrity",
  "omissions_reasoned",
  "summary_length_ok",
  "page_budget_ok",
  "output_language_ok",
  "extraction_gate_ok",
];

async function runAll(overrides: Partial<BenchmarkConfig> = {}) {
  return runBenchmarkSet({ config: baseConfig(overrides), fixtureSet });
}

beforeEach(() => {
  mockState.failCV = false;
  mockState.costPerCall = 0;
  callLLMMock.mockReset();
  callLLMMock.mockImplementation(mockImpl);
});

describe("benchmark runner", () => {
  it(
    "runs every fixture case end-to-end and records a complete result set",
    async () => {
      const outcome = await runAll();
      expect(outcome.status).toBe("complete");
      expect(outcome.caseResults.map((c) => c.caseId)).toEqual([
        "en-hard-constraints",
        "en-standard",
        "fr-cross-language",
        "fr-poor-match",
      ]);
      for (const result of outcome.caseResults) {
        expect(result.status).toBe("ok");
        expect(result.metrics.map((m) => m.metricId).sort()).toEqual([...METRIC_IDS].sort());
        const byId = new Map(result.metrics.map((m) => [m.metricId, m]));
        expect(byId.get("selection_integrity")).toMatchObject({ value: true, category: "deterministic" });
        expect(byId.get("omissions_reasoned")?.value).toBe(true);
        expect(byId.get("summary_length_ok")?.value).toBe(true);
        expect(byId.get("page_budget_ok")?.value).toBe(true);
        expect(byId.get("extraction_gate_ok")?.value).toBe(true);
        const coverage = byId.get("requirement_coverage")!;
        expect(coverage.category).toBe("model_dependent");
        expect(coverage.value).toBeGreaterThan(0);
        // The identity-echo mock cannot translate, so only same-language cases
        // are expected to pass the language check.
        if (result.caseId === "en-hard-constraints" || result.caseId === "en-standard") {
          expect(byId.get("output_language_ok")?.value).toBe(true);
        }
      }
    },
    240_000,
  );

  it(
    "reproduces deterministic metric values across identical runs",
    async () => {
      type CaseResultOf = Awaited<ReturnType<typeof runBenchmarkSet>>["caseResults"][number];
      const deterministic = (r: CaseResultOf) =>
        r.metrics.filter((m) => m.category === "deterministic").map((m) => [m.metricId, m.value]);
      const first = await runAll({ caseIds: ["en-standard"] });
      const second = await runAll({ caseIds: ["en-standard"] });
      expect(deterministic(second.caseResults[0])).toEqual(deterministic(first.caseResults[0]));
      expect(second.caseResults[0].status).toBe("ok");
    },
    240_000,
  );

  it(
    "records a failed case and marks the run incomplete when a pipeline stage fails",
    async () => {
      mockState.failCV = true;
      const outcome = await runAll({ caseIds: ["en-standard"] });
      expect(outcome.status).toBe("incomplete");
      const result = outcome.caseResults[0];
      expect(result.status).toBe("failed");
      expect(result.failure?.stage).toBe("generation_cv");
      expect(result.failure?.cause).toContain("provider exploded");
    },
    240_000,
  );

  it(
    "aborts with an incomplete run when the spend cap is hit",
    async () => {
      mockState.costPerCall = 0.5; // two LLM calls exceed the 0.60 cap
      const outcome = await runAll({ spendCapUsd: 0.6 });
      expect(outcome.status).toBe("incomplete");
      expect(outcome.incompleteReason).toMatch(/spend cap/i);
      // SC-002: even unrun cases are recorded, never silently missing
      expect(outcome.caseResults).toHaveLength(4);
      expect(outcome.caseResults.filter((c) => c.status === "failed").length).toBeGreaterThanOrEqual(1);
    },
    240_000,
  );

  it("assembles a schema-valid report with honest verdict semantics", async () => {
    const okResult = (caseId: string) => ({
      caseId,
      status: "ok" as const,
      metrics: [
        { metricId: "requirement_coverage", value: 0.9, category: "model_dependent" as const, baselineValue: null, comparison: "skipped" as const },
      ],
      spendUsd: 0,
    });
    // Full run, all cases ok, comparison skipped (no baseline yet) ⇒ pass.
    const full = assembleReport({
      runId: "2026-10-28T00-00-00-full",
      config: baseConfig({ label: "full" }),
      fixtureSetVersion: fixtureSet.version,
      codeState: { sha: "test0000", dirty: true },
      caseResults: fixtureSet.manifest.cases.map((c) => okResult(c.id)),
      spendUsd: 0,
      durationMs: 1,
      status: "complete",
    });
    expect(full.schema).toBe("profileforge.benchmark.report/1");
    expect(full.verdict).toBe("pass");
    expect(full.partial).toBe(false);
    expect(full.comparison.outcome).toBe("skipped");

    // A --case subset can never verdict pass (data-model invariant).
    const partial = assembleReport({
      runId: "2026-10-28T00-00-00-sub",
      config: baseConfig({ caseIds: ["en-standard"] }),
      fixtureSetVersion: fixtureSet.version,
      codeState: { sha: "test0000", dirty: false },
      caseResults: [okResult("en-standard")],
      spendUsd: 0,
      durationMs: 1,
      status: "complete",
    });
    expect(partial.partial).toBe(true);
    expect(partial.verdict).toBe("incomplete");
  });
});
