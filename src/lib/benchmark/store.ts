import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkReport } from "@/lib/benchmark/report";
import type { CaseResult } from "@/lib/benchmark/runner";

/**
 * Run/baseline persistence under benchmarks/ (research D7). Run reports are
 * retained per run (gitignored); baselines are committed source.
 */

export const BENCHMARK_ROOT = join(process.cwd(), "benchmarks");

// --- Baselines (data-model.md §7, FR-012) ---

export type BenchmarkBaseline = {
  fixtureSetVersion: string;
  pinnedAt: string;
  pinnedBy: string;
  codeState: { sha: string; dirty: boolean };
  models: Record<string, string>;
  dictionaryVersion: "v1";
  cases: Record<string, Record<string, number | boolean>>;
};

/** Build the baseline document for the current run — every re-pin is auditable. */
export function buildBaseline(args: {
  fixtureSetVersion: string;
  label?: string;
  codeState: { sha: string; dirty: boolean };
  models: Record<string, string>;
  caseResults: CaseResult[];
}): BenchmarkBaseline {
  const cases: BenchmarkBaseline["cases"] = {};
  for (const c of args.caseResults) {
    cases[c.caseId] = Object.fromEntries(c.metrics.map((m) => [m.metricId, m.value]));
  }
  return {
    fixtureSetVersion: args.fixtureSetVersion,
    pinnedAt: new Date().toISOString(),
    pinnedBy: args.label ?? "unspecified",
    codeState: args.codeState,
    models: args.models,
    dictionaryVersion: "v1",
    cases,
  };
}

function slug(label: string | undefined): string {
  const s = (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "run";
}

/** `<UTC timestamp>-<label>` — lexicographically sortable run identity. */
export function makeRunId(label?: string, now: Date = new Date()): string {
  const iso = now.toISOString().replace(/\..+/, "").replace(/:/g, "-");
  return `${iso}-${slug(label)}`;
}

export function getCodeState(): { sha: string; dirty: boolean } {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    let dirty = true;
    try {
      dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    } catch {
      // keep dirty=true when unanswerable
    }
    return { sha, dirty };
  } catch {
    return { sha: "unknown", dirty: true };
  }
}

export function persistRunReport(
  benchmarkRoot: string,
  runId: string,
  report: BenchmarkReport,
  summaryMd: string,
): { reportPath: string; summaryPath: string } {
  const dir = join(benchmarkRoot, "runs", runId);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "report.json");
  const summaryPath = join(dir, "summary.md");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(summaryPath, summaryMd + "\n");
  return { reportPath, summaryPath };
}

export function readBaseline(benchmarkRoot: string, fixtureSetVersion: string): unknown | null {
  const file = join(benchmarkRoot, "baselines", `${fixtureSetVersion}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeBaseline(benchmarkRoot: string, fixtureSetVersion: string, baseline: unknown): string {
  const dir = join(benchmarkRoot, "baselines");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${fixtureSetVersion}.json`);
  writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
  return file;
}
