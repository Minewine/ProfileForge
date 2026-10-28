import { describe, expect, it } from "vitest";
import type { BenchmarkBaseline } from "@/lib/benchmark/store";
import { buildBaseline } from "@/lib/benchmark/store";
import { assembleReport, compareWithBaseline, computeVerdict, type BenchmarkReport } from "@/lib/benchmark/report";
import type { CaseResult } from "@/lib/benchmark/runner";
import type { MetricResult } from "@/lib/benchmark/metrics";

function m(metricId: string, value: number | boolean, category: MetricResult["category"] = "deterministic"): MetricResult {
  return { metricId, value, category, baselineValue: null, comparison: "skipped" };
}

function caseResult(caseId: string, metrics: MetricResult[]): CaseResult {
  return { caseId, status: "ok", metrics, spendUsd: 0 };
}

function baseline(over: Partial<BenchmarkBaseline> = {}): BenchmarkBaseline {
  return {
    fixtureSetVersion: "abc123",
    pinnedAt: "2026-10-28T00:00:00Z",
    pinnedBy: "test",
    codeState: { sha: "test0000", dirty: false },
    models: {},
    dictionaryVersion: "v1",
    cases: {
      "en-standard": {
        requirement_coverage: 0.9,
        selection_integrity: true,
        output_language_ok: true,
      },
      "fr-poor-match": { requirement_coverage: 0.7 },
    },
    ...over,
  };
}

const DETERMINISTIC_OK = [
  m("selection_integrity", true),
  m("omissions_reasoned", true),
  m("summary_length_ok", true),
  m("page_budget_ok", true),
  m("output_language_ok", true),
  m("extraction_gate_ok", true),
];

describe("baseline comparison (US3)", () => {
  it("compares deterministic metrics with zero tolerance", () => {
    const results = [caseResult("en-standard", [...DETERMINISTIC_OK, m("requirement_coverage", 0.9, "model_dependent")])];
    const { comparison, caseResults } = compareWithBaseline({
      caseResults: results,
      baseline: baseline(),
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: [],
    });
    expect(comparison.outcome).toBe("ok");
    const sel = caseResults[0].metrics.find((x) => x.metricId === "selection_integrity")!;
    expect(sel).toMatchObject({ baselineValue: true, comparison: "ok" });
  });

  it("flags a deterministic metric that differs from the baseline by any amount", () => {
    const results = [
      caseResult("en-standard", [m("selection_integrity", false), m("requirement_coverage", 0.9, "model_dependent")]),
    ];
    const { comparison } = compareWithBaseline({
      caseResults: results,
      baseline: baseline(),
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: [],
    });
    expect(comparison.outcome).toBe("regressed");
  });

  it("applies the requirement_coverage band with the absolute floor", () => {
    const mk = (coverage: number) => [
      caseResult("en-standard", [...DETERMINISTIC_OK, m("requirement_coverage", coverage, "model_dependent")]),
    ];
    // within band and above floor
    expect(
      compareWithBaseline({ caseResults: mk(0.86), baseline: baseline(), fixtureSetVersion: "abc123", weakMatchCaseIds: [] }).comparison.outcome,
    ).toBe("ok");
    // outside band
    expect(
      compareWithBaseline({ caseResults: mk(0.84), baseline: baseline(), fixtureSetVersion: "abc123", weakMatchCaseIds: [] }).comparison.outcome,
    ).toBe("regressed");
    // below absolute floor even though within band
    const lowBaseline = baseline({
      cases: { "en-standard": { ...baseline().cases["en-standard"], requirement_coverage: 0.7 } },
    });
    expect(
      compareWithBaseline({ caseResults: mk(0.68), baseline: lowBaseline, fixtureSetVersion: "abc123", weakMatchCaseIds: [] }).comparison.outcome,
    ).toBe("regressed");
  });

  it("waives the requirement_coverage floor only for weak-match cases", () => {
    const results = [caseResult("fr-poor-match", [...DETERMINISTIC_OK, m("requirement_coverage", 0.68, "model_dependent")])];
    const waived = compareWithBaseline({
      caseResults: results,
      baseline: baseline(),
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: ["fr-poor-match"],
    });
    expect(waived.comparison.outcome).toBe("ok");
    const enforced = compareWithBaseline({
      caseResults: results,
      baseline: baseline(),
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: [],
    });
    expect(enforced.comparison.outcome).toBe("regressed");
  });

  it("skips comparison — with a stated reason — when no baseline exists", () => {
    const { comparison } = compareWithBaseline({
      caseResults: [caseResult("en-standard", DETERMINISTIC_OK)],
      baseline: null,
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: [],
    });
    expect(comparison).toMatchObject({ baseline: null, outcome: "skipped" });
    expect(comparison.reason).toMatch(/no baseline/i);
  });

  it("skips comparison — with a stated reason — on a fixture-set version mismatch", () => {
    const { comparison } = compareWithBaseline({
      caseResults: [caseResult("en-standard", DETERMINISTIC_OK)],
      baseline: baseline({ fixtureSetVersion: "older000" }),
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: [],
    });
    expect(comparison.outcome).toBe("skipped");
    expect(comparison.reason).toMatch(/older000/);
  });

  it("a regressed comparison makes the verdict regressed (exit-1 path)", () => {
    const { comparison, caseResults } = compareWithBaseline({
      caseResults: [caseResult("en-standard", [...DETERMINISTIC_OK, m("requirement_coverage", 0.5, "model_dependent")])],
      baseline: baseline(),
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: [],
    });
    const verdict = computeVerdict({ status: "complete", partial: false, caseResults, comparison });
    expect(verdict).toBe("regressed");
  });

  it("assembled reports carry the comparison outcome and per-metric detail", () => {
    const { comparison, caseResults } = compareWithBaseline({
      caseResults: [caseResult("en-standard", [...DETERMINISTIC_OK, m("requirement_coverage", 0.9, "model_dependent")])],
      baseline: baseline(),
      fixtureSetVersion: "abc123",
      weakMatchCaseIds: [],
    });
    const report: BenchmarkReport = assembleReport({
      runId: "r1",
      config: { mode: "live", models: {}, spendCapUsd: 1, compare: true, updateBaseline: false },
      fixtureSetVersion: "abc123",
      codeState: { sha: "test0000", dirty: false },
      caseResults,
      spendUsd: 0,
      durationMs: 1,
      status: "complete",
      comparison,
    });
    expect(report.comparison).toMatchObject({ baseline: "abc123", outcome: "ok" });
    const cov = report.cases[0].metrics.find((x) => x.metricId === "requirement_coverage")!;
    expect(cov).toMatchObject({ baselineValue: 0.9, comparison: "ok" });
    expect(report.verdict).toBe("pass");
  });
});

describe("baseline pinning (US3)", () => {
  it("builds a baseline with full provenance metadata", () => {
    const results = [caseResult("en-standard", [...DETERMINISTIC_OK, m("requirement_coverage", 0.9, "model_dependent")])];
    const b = buildBaseline({
      fixtureSetVersion: "abc123",
      label: "first baseline",
      codeState: { sha: "test0000", dirty: false },
      models: { generateTailoredCV: "acme/model" },
      caseResults: results,
    });
    expect(b.fixtureSetVersion).toBe("abc123");
    expect(b.pinnedBy).toBe("first baseline");
    expect(b.dictionaryVersion).toBe("v1");
    expect(b.cases["en-standard"]["requirement_coverage"]).toBe(0.9);
    expect(b.cases["en-standard"]["selection_integrity"]).toBe(true);
    expect(typeof b.pinnedAt).toBe("string");
  });
});
