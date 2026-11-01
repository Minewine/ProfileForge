/**
 * Benchmark CLI entry (specs/009-evaluation-benchmark, contracts/cli.md).
 *
 * Boot order matters: dotenv → argv parse → benchmark environment guard
 * (DATABASE_URL must target profileforge_benchmark) → schema reset → only then
 * are the app modules (and the Prisma client) imported.
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig();

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BenchmarkFatalError, loadBenchmarkConfig, type BenchmarkConfigInput } from "@/lib/benchmark/config";
import { applyBenchmarkEnvironment } from "@/lib/benchmark/env";
import type { BenchmarkBaseline } from "@/lib/benchmark/store";

type ParsedArgs = {
  overrides: BenchmarkConfigInput;
  flags: { json: boolean; keyless: boolean; record: boolean };
};

function parseArgs(argv: string[]): ParsedArgs {
  const overrides: BenchmarkConfigInput = {};
  const flags = { json: false, keyless: false, record: false };
  const caseIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      if (i + 1 >= argv.length) throw new BenchmarkFatalError(3, `Flag ${arg} requires a value.`);
      return argv[++i];
    };
    switch (arg) {
      case "--label":
        overrides.label = next();
        break;
      case "--case":
        caseIds.push(next());
        break;
      case "--cap": {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) {
          throw new BenchmarkFatalError(3, `--cap must be a positive number (got "${value}").`);
        }
        overrides.spendCapUsd = value;
        break;
      }
      case "--models": {
        const raw = next();
        const models: Record<string, string> = { ...(overrides.models as Record<string, string>) };
        for (const pair of raw.split(",")) {
          const [task, model] = pair.split("=", 2);
          if (!task || !model) {
            throw new BenchmarkFatalError(3, `--models entries must look like task=model (got "${pair}").`);
          }
          models[task.trim()] = model.trim();
        }
        overrides.models = models;
        break;
      }
      case "--no-compare":
        overrides.compare = false;
        break;
      case "--update-baseline":
        overrides.updateBaseline = true;
        break;
      case "--keyless":
        flags.keyless = true;
        break;
      case "--record":
        flags.record = true;
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new BenchmarkFatalError(3, `Unknown flag "${arg}".`);
    }
  }
  if (caseIds.length > 0) overrides.caseIds = caseIds;
  return { overrides, flags };
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✋ ${message}`);
    return 3;
  }

  try {
    const config = loadBenchmarkConfig({ overrides: parsed.overrides });
    const keyless = parsed.flags.keyless || config.mode === "replay";
    if (parsed.flags.record && keyless) {
      throw new BenchmarkFatalError(3, "--record and --keyless are mutually exclusive.");
    }

    const url = applyBenchmarkEnvironment();
    const { resetBenchmarkSchema } = await import("@/lib/benchmark/workspace");
    console.log(`• benchmark database: ${url}`);
    console.log("• resetting the benchmark schema…");
    await resetBenchmarkSchema(url);

    const { loadFixtureSet } = await import("@/lib/benchmark/fixtures");
    const fixtureSet = loadFixtureSet("benchmarks/fixtures");
    // Prompt-set identity: any byte change to src/lib/llm/prompts/*.md forces a
    // baseline re-pin (compareWithBaseline), like a fixture-set change does.
    const { computePromptSetVersion } = await import("@/lib/llm/prompts/load");
    const promptSetVersion = computePromptSetVersion();
    console.log(`• prompt set: ${promptSetVersion}`);

    // US5: swap the router's transport for record/replay before any case runs.
    // keyless mode needs no AI credentials — replay serves pinned transcripts
    // and a miss fails the run loudly (TRANSCRIPT_MISS), never synthesizes.
    const { TranscriptStore, benchmarkTransport, makeReplayTransport, resetTransport } = await import(
      "@/lib/benchmark/transcripts"
    );
    const { setLlmTransport } = await import("@/lib/llm/transport");
    const store = new TranscriptStore("benchmarks/transcripts");
    if (keyless) {
      console.log("• keyless mode: replaying pinned transcripts — deterministic stages only (no live AI evaluation)");
      setLlmTransport(makeReplayTransport(store, fixtureSet.version));
    } else if (parsed.flags.record) {
      console.log("• recording AI transcripts for this fixture-set version…");
      setLlmTransport(benchmarkTransport("record", store, fixtureSet.version));
    }

    try {
      console.log(
        `• running ${config.caseIds?.length ?? fixtureSet.manifest.cases.length} case(s) from fixture set ${fixtureSet.version}…`,
      );
      const startedAt = Date.now();
      const { runBenchmarkSet } = await import("@/lib/benchmark/runner");
      const outcome = await runBenchmarkSet({ config, fixtureSet, transcripts: store });
      const durationMs = Date.now() - startedAt;

      // Baseline comparison (US3): deterministic zero tolerance + threshold bands.
      let comparison;
      let caseResults = outcome.caseResults;
      let baselineDoc: BenchmarkBaseline | null = null;
      if (!config.compare) {
        comparison = { baseline: null, outcome: "skipped" as const, reason: "comparison disabled (--no-compare)" };
      } else {
        const { readBaseline } = await import("@/lib/benchmark/store");
        baselineDoc = (readBaseline("benchmarks", fixtureSet.version) as BenchmarkBaseline | null) ?? null;
        // The absolute coverage floor is waived for cases whose FIXTURE caps
        // coverage by construction: weak-match JDs and hard-constraints-heavy
        // JDs (deliberately unmatched hard requirements), like the weak-match
        // waiver in compareWithBaseline (report.ts).
        const floorWaivedJdIds = new Set(
          fixtureSet.manifest.jds.filter((j) => j.weakMatch || j.hardConstraintsHeavy).map((j) => j.id),
        );
        const weakMatchCaseIds = fixtureSet.manifest.cases.filter((c) => floorWaivedJdIds.has(c.jdId)).map((c) => c.id);
        const { compareWithBaseline } = await import("@/lib/benchmark/report");
        ({ comparison, caseResults } = compareWithBaseline({
          caseResults: outcome.caseResults,
          baseline: baselineDoc,
          fixtureSetVersion: fixtureSet.version,
          promptSetVersion,
          weakMatchCaseIds,
        }));
      }

      const { getCodeState, makeRunId, persistRunReport } = await import("@/lib/benchmark/store");
      const { assembleReport, renderSummaryMd } = await import("@/lib/benchmark/report");
      const runId = makeRunId(config.label);
      const report = assembleReport({
        runId,
        config,
        fixtureSetVersion: fixtureSet.version,
        codeState: getCodeState(),
        promptSetVersion,
        caseResults,
        spendUsd: outcome.spendUsd,
        durationMs,
        status: outcome.status,
        notes: outcome.incompleteReason ? [outcome.incompleteReason] : [],
        comparison,
        keylessMode: keyless,
      });

      // Persist the report FIRST — every run, successful or not, leaves its
      // evidence on disk before anything else (baselines, exits) can intervene.
      const { reportPath, summaryPath } = persistRunReport("benchmarks", runId, report, renderSummaryMd(report));

      if (config.updateBaseline) {
        if (report.status !== "complete" || report.partial) {
          throw new BenchmarkFatalError(3, "--update-baseline requires a complete, non-partial run (every selected case ok).");
        }
        const { buildBaseline, writeBaseline } = await import("@/lib/benchmark/store");
        const baselinePath = writeBaseline(
          "benchmarks",
          fixtureSet.version,
          buildBaseline({
            fixtureSetVersion: fixtureSet.version,
            promptSetVersion,
            label: config.label,
            codeState: report.codeState,
            models: config.models,
            caseResults: outcome.caseResults,
          }),
        );
        console.log(`• baseline pinned: ${baselinePath}`);
      }

      if (baselineDoc) {
        const { renderComparisonMd } = await import("@/lib/benchmark/report");
        const comparisonPath = join("benchmarks", "runs", runId, "comparison.md");
        writeFileSync(comparisonPath, renderComparisonMd(report, baselineDoc) + "\n");
        console.log(`• comparison: ${comparisonPath}`);
      }

      if (parsed.flags.json) {
        console.log(JSON.stringify({ runId, verdict: report.verdict, reportPath, cases: report.cases.length }, null, 2));
      } else {
        console.log(`• verdict: ${report.verdict.toUpperCase()} (${report.status})`);
        for (const c of report.cases) {
          console.log(
            `  - ${c.caseId}: ${c.status}${c.failure ? ` — ${c.failure.stage}: ${c.failure.cause}` : ` (${c.metrics.length} metrics)`}`,
          );
        }
        console.log(`• report: ${reportPath}`);
        console.log(`• summary: ${summaryPath}`);
      }

      // Exit codes (contracts/cli.md): 0 pass · 1 regressed · 2 incomplete · 3 config.
      if (report.verdict === "regressed") return 1;
      if (report.verdict === "incomplete") return 2;
      return 0;
    } finally {
      resetTransport();
    }
  } catch (err) {
    if (err instanceof BenchmarkFatalError) {
      console.error(`✋ ${err.message}`);
      return err.exitCode;
    }
    console.error(`✋ benchmark crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 3;
  }
}

main().then((code) => {
  process.exit(code);
});
