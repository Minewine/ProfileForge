import { z } from "zod";
import type { BenchmarkConfig } from "@/lib/benchmark/config";
import type { CaseResult } from "@/lib/benchmark/runner";
import type { BenchmarkBaseline } from "@/lib/benchmark/store";

/**
 * The benchmark report document — exactly the contract in
 * specs/009-evaluation-benchmark/contracts/metrics.md §Report.
 */

export const ReportSchema = z.object({
  schema: z.literal("profileforge.benchmark.report/1"),
  runId: z.string().min(1),
  verdict: z.enum(["pass", "regressed", "incomplete"]),
  status: z.enum(["complete", "incomplete"]),
  partial: z.boolean(),
  fixtureSetVersion: z.string().min(1),
  dictionaryVersion: z.literal("v1"),
  codeState: z.object({ sha: z.string(), dirty: z.boolean() }),
  config: z.object({
    mode: z.enum(["live", "replay"]),
    models: z.record(z.string(), z.string()),
    spendCapUsd: z.number().positive(),
  }),
  spendUsd: z.number().min(0),
  durationMs: z.number().min(0),
  comparison: z.object({
    baseline: z.string().nullable(),
    outcome: z.enum(["ok", "regressed", "skipped"]),
    reason: z.string().nullable(),
  }),
  cases: z.array(
    z.object({
      caseId: z.string(),
      status: z.enum(["ok", "failed"]),
      failure: z.object({ stage: z.string(), cause: z.string() }).optional(),
      metrics: z.array(
        z.object({
          metricId: z.string(),
          value: z.union([z.number(), z.boolean()]),
          category: z.enum(["deterministic", "model_dependent"]),
          baselineValue: z.union([z.number(), z.boolean()]).nullable(),
          comparison: z.enum(["ok", "regressed", "skipped"]),
        }),
      ),
    }),
  ),
  keylessMode: z.boolean(),
  notes: z.array(z.string()),
});

export type BenchmarkReport = z.infer<typeof ReportSchema>;

/** Deterministic metrics carry absolute expectations (zero tolerance, no
 *  baseline needed) — contracts/metrics.md dictionary v1. A miss fails the run
 *  outright (SC-003 semantics). */
export const DETERMINISTIC_EXPECTATIONS: Record<string, boolean | number> = {
  selection_integrity: true,
  omissions_reasoned: true,
  summary_length_ok: true,
  page_budget_ok: true,
  output_language_ok: true,
  extraction_gate_ok: true,
};

export function deterministicExpectationMisses(
  caseResults: CaseResult[],
): Array<{ caseId: string; metricId: string; value: number | boolean }> {
  const misses: Array<{ caseId: string; metricId: string; value: number | boolean }> = [];
  for (const c of caseResults) {
    for (const m of c.metrics) {
      const expected = DETERMINISTIC_EXPECTATIONS[m.metricId];
      if (m.category === "deterministic" && expected !== undefined && m.value !== expected) {
        misses.push({ caseId: c.caseId, metricId: m.metricId, value: m.value });
      }
    }
  }
  return misses;
}

// --- Baseline comparison (US3, FR-010; thresholds = contracts/metrics.md v1) ---

const MODEL_DEPENDENT_THRESHOLDS: Record<string, { maxDelta: number; absoluteFloor: number; floorWaivable: boolean }> = {
  requirement_coverage: { maxDelta: 0.05, absoluteFloor: 0.8, floorWaivable: true },
};

export type ComparisonOutcome = {
  baseline: string | null;
  outcome: "ok" | "regressed" | "skipped";
  reason: string | null;
};

/**
 * Compare a run against the pinned baseline: deterministic metrics with zero
 * tolerance, model-dependent metrics with per-metric bands and floors. The
 * requirement_coverage absolute floor is waived for weak-match cases (their
 * low coverage is the fixture's point); the band still applies.
 */
export function compareWithBaseline(args: {
  caseResults: CaseResult[];
  baseline: unknown;
  fixtureSetVersion: string;
  weakMatchCaseIds: string[];
}): { comparison: ComparisonOutcome; caseResults: CaseResult[] } {
  const base = args.baseline as BenchmarkBaseline | null;
  if (!base || typeof base !== "object" || !("cases" in base)) {
    return {
      comparison: {
        baseline: null,
        outcome: "skipped",
        reason: "no baseline stored for this fixture-set version — pin one with --update-baseline",
      },
      caseResults: args.caseResults,
    };
  }
  if (base.fixtureSetVersion !== args.fixtureSetVersion) {
    return {
      comparison: {
        baseline: base.fixtureSetVersion,
        outcome: "skipped",
        reason: `baseline is for fixture-set version ${base.fixtureSetVersion}, current set is ${args.fixtureSetVersion} — re-pin with --update-baseline`,
      },
      caseResults: args.caseResults,
    };
  }

  let regressed = false;
  const updated = args.caseResults.map((c) => {
    const baseCase = base.cases[c.caseId];
    if (!baseCase) return c;
    const metrics = c.metrics.map((m) => {
      if (m.category === "deterministic") {
        const baseValue = baseCase[m.metricId];
        if (baseValue === undefined) return { ...m, baselineValue: null, comparison: "skipped" as const };
        const ok = baseValue === m.value;
        if (!ok) regressed = true;
        return { ...m, baselineValue: baseValue as number | boolean, comparison: ok ? ("ok" as const) : ("regressed" as const) };
      }
      const threshold = MODEL_DEPENDENT_THRESHOLDS[m.metricId];
      const baseValue = baseCase[m.metricId];
      if (!threshold || typeof m.value !== "number" || typeof baseValue !== "number") {
        return {
          ...m,
          baselineValue: (baseValue as number | boolean | undefined) ?? null,
          comparison: threshold && typeof baseValue === "number" ? ("ok" as const) : ("skipped" as const),
        };
      }
      const delta = baseValue - m.value; // positive = worse than baseline
      const floorWaived = threshold.floorWaivable && args.weakMatchCaseIds.includes(c.caseId);
      const ok = delta <= threshold.maxDelta && (floorWaived || m.value >= threshold.absoluteFloor);
      if (!ok) regressed = true;
      return { ...m, baselineValue: baseValue, comparison: ok ? ("ok" as const) : ("regressed" as const) };
    });
    return { ...c, metrics };
  });

  return {
    comparison: {
      baseline: base.fixtureSetVersion,
      outcome: regressed ? "regressed" : "ok",
      reason: regressed ? "metric(s) regressed past their threshold — see per-metric comparison" : null,
    },
    caseResults: updated,
  };
}

/** Verdict semantics (data-model.md §Cross-entity invariants). Comparison comes
 *  in with US3; until then every comparison is honestly "skipped". */
export function computeVerdict(args: {
  status: "complete" | "incomplete";
  partial: boolean;
  caseResults: CaseResult[];
  comparison?: { outcome: "ok" | "regressed" | "skipped" };
}): "pass" | "regressed" | "incomplete" {
  if (args.status !== "complete" || args.partial) return "incomplete";
  if (args.caseResults.some((c) => c.status !== "ok")) return "incomplete";
  if (deterministicExpectationMisses(args.caseResults).length > 0) return "regressed";
  if (args.comparison?.outcome === "regressed") return "regressed";
  return "pass";
}

export function assembleReport(args: {
  runId: string;
  config: BenchmarkConfig;
  fixtureSetVersion: string;
  codeState: { sha: string; dirty: boolean };
  caseResults: CaseResult[];
  spendUsd: number;
  durationMs: number;
  status: "complete" | "incomplete";
  keylessMode?: boolean;
  notes?: string[];
  comparison?: ComparisonOutcome;
}): BenchmarkReport {
  const partial = Array.isArray(args.config.caseIds) && args.config.caseIds.length > 0;
  const comparison: ComparisonOutcome = args.comparison ?? {
    baseline: null,
    outcome: "skipped",
    reason: "no baseline stored for this fixture-set version — pin one with --update-baseline",
  };
  const verdict = computeVerdict({ status: args.status, partial, caseResults: args.caseResults, comparison });

  const notes = [...(args.notes ?? [])];
  if (args.status === "incomplete") {
    notes.push("run incomplete — verdict cannot be pass");
  }

  return ReportSchema.parse({
    schema: "profileforge.benchmark.report/1",
    runId: args.runId,
    verdict,
    status: args.status,
    partial,
    fixtureSetVersion: args.fixtureSetVersion,
    dictionaryVersion: "v1",
    codeState: args.codeState,
    config: {
      mode: args.config.mode,
      models: args.config.models,
      spendCapUsd: args.config.spendCapUsd,
    },
    spendUsd: Math.round(args.spendUsd * 1e6) / 1e6,
    durationMs: args.durationMs,
    comparison: {
      baseline: comparison.baseline,
      outcome: comparison.outcome,
      reason: comparison.reason,
    },
    cases: args.caseResults.map((c) => ({
      caseId: c.caseId,
      status: c.status,
      ...(c.failure ? { failure: c.failure } : {}),
      metrics: c.metrics,
    })),
    keylessMode: args.keylessMode ?? false,
    notes,
  });
}

/** Human-readable summary: verdict first, failed cases first, then per-case metrics. */
export function renderSummaryMd(report: BenchmarkReport): string {  const lines: string[] = [];
  lines.push(`# Benchmark run ${report.runId}`);
  lines.push("");
  lines.push(
    `**Verdict: ${report.verdict.toUpperCase()}** · status ${report.status} · spend $${report.spendUsd.toFixed(4)} · ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push("");
  lines.push(
    `fixture set \`${report.fixtureSetVersion}\` · code ${report.codeState.sha}${report.codeState.dirty ? " (dirty)" : ""} · mode ${report.config.mode}${report.keylessMode ? " · **deterministic stages only** (no live AI evaluation)" : ""}`,
  );
  lines.push("");
  lines.push(
    `Comparison: ${report.comparison.outcome}${report.comparison.reason ? ` — ${report.comparison.reason}` : ""}`,
  );
  lines.push("");
  const failed = report.cases.filter((c) => c.status === "failed");
  for (const c of failed) {
    lines.push(`⚠ **${c.caseId} FAILED** (${c.failure?.stage ?? "?"}): ${c.failure?.cause ?? "?"}`);
  }
  if (failed.length > 0) lines.push("");
  for (const c of report.cases) {
    lines.push(`## ${c.caseId} — ${c.status}`);
    lines.push("");
    lines.push("| metric | value | category | vs baseline |");
    lines.push("|---|---|---|---|");
    for (const m of c.metrics) {
      lines.push(
        `| ${m.metricId} | ${m.value} | ${m.category} | ${m.comparison === "skipped" ? "—" : `${m.comparison} (baseline ${m.baselineValue})`} |`,
      );
    }
    lines.push("");
  }
  if (report.keylessMode) {
    lines.push("> Deterministic stages only — live AI stages were NOT evaluated in this run.");
    lines.push("");
  }
  if (report.notes.length > 0) {
    lines.push(`Notes: ${report.notes.join(" · ")}`);
  }
  return lines.join("\n");
}

/** Side-by-side view of the current run against the pinned baseline (US4,
 *  SC-006): quality metrics per case, plus run-level spend and
 *  duration — without re-running the baseline. */
export function renderComparisonMd(current: BenchmarkReport, baseline: BenchmarkBaseline): string {
  const lines: string[] = [];
  lines.push(`# Model-swap comparison — ${current.runId}`);
  lines.push("");
  lines.push(
    `current models: \`${JSON.stringify(current.config.models)}\` · baseline models: \`${JSON.stringify(baseline.models)}\` (pinned ${baseline.pinnedAt} by ${baseline.pinnedBy})`,
  );
  lines.push("");
  for (const c of current.cases) {
    const baseCase = baseline.cases[c.caseId] ?? {};
    lines.push(`## ${c.caseId}`);
    lines.push("");
    lines.push("| metric | current | baseline |");
    lines.push("|---|---|---|");
    for (const m of c.metrics) {
      const bv = baseCase[m.metricId];
      lines.push(`| ${m.metricId} | ${m.value} | ${bv ?? "—"} |`);
    }
    lines.push("");
  }
  lines.push(
    `current run: spend $${current.spendUsd.toFixed(4)}, ${(current.durationMs / 1000).toFixed(1)}s (the baseline document retains values, not run timing).`,
  );
  return lines.join("\n");
}
