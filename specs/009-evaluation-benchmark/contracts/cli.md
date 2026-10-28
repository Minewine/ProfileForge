# Contract: Benchmark CLI

The benchmark's external interface is a single command with flags, environment variables, exit
codes, and file outputs. This is the automation-facing contract (FR-001, FR-011, FR-013).

## Command

```bash
npm run benchmark -- [flags]
```

(Implementation: `scripts/run-benchmark.ts` via tsx; the npm script is the stable entry.)

## Flags

| Flag | Values | Default | Effect |
|---|---|---|---|
| `--keyless` | — | off | forces `mode=replay`; no AI credentials required; report labeled "deterministic stages only" (FR-014) |
| `--record` | — | off | live call + transcript recording for the current fixture-set version (enables later keyless runs) |
| `--models` | `task=model[,task=model…]` | from `benchmark.config.json`, else current defaults | per-task model override (FR-004); unknown task id ⇒ exit 3 |
| `--cap` | USD figure > 0 | `1.00` | per-run spend cap; exceed ⇒ abort, incomplete, exit 2 (FR-013) |
| `--no-compare` | — | off | skip baseline comparison (reported as skipped) |
| `--update-baseline` | — | off | pin this run's values as the baseline for the fixture-set version (FR-012); requires `status=complete` and `partial=false` |
| `--label` | text | — | human label in run + baseline metadata |
| `--case` | case id (repeatable) | all | run a subset; report marked `partial`, verdict can never be `pass` |
| `--json` | — | off | machine-readable summary on stdout (report path, verdict, per-metric deltas) |

Config precedence: flags > `benchmarks/benchmark.config.json` > built-in defaults.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | must target the `profileforge_benchmark` database — the harness refuses to boot otherwise (exit 3); `BENCHMARK_DATABASE_URL` may supply it explicitly |
| `OPENROUTER_API_KEY` | live/record modes | AI credentials; ignored (absence fine) under `--keyless` |

The harness creates/updates the benchmark database schema (migrate deploy) and resets data at run
start; `UPLOADS_DIR` is forced to `./uploads-benchmark`.

## Exit codes (FR-011)

| Code | Verdict | Meaning |
|---|---|---|
| 0 | `pass` | complete run, no regression, all deterministic expectations met |
| 1 | `regressed` | complete run; at least one metric crossed its threshold, or a deterministic expectation failed |
| 2 | `incomplete` | aborted or partially measured: spend cap, provider failure, transcript miss, or all cases failed; report states spend-so-far and cause |
| 3 | — | configuration/infrastructure error before or at boot: bad flags/config, wrong database, fixture-set validation failure |

Comparison skipped due to a missing/mismatched baseline is **not** an error: the run can still
verdict `pass` with `comparison: skipped` and the reason stated (FR-012).

## Outputs

- `benchmarks/runs/<runId>/report.json` — the report document (see contracts/metrics.md §Report).
- `benchmarks/runs/<runId>/summary.md` — human-readable rendering: verdict, per-case metrics table,
  regressions first, spend/duration, comparison outcome.
- stdout — one-line verdict + report path (or full JSON with `--json`).
- `--update-baseline` additionally writes `benchmarks/baselines/<fixtureSetVersion>.json`.

## Guarantees

1. Boot-time validation happens before any AI call: config schema, fixture-set completeness
   (FR-002), database guard (D2). Any violation ⇒ exit 3 with the reason.
2. Every manifest case (or `--case` subset) appears in the report with `ok` or `failed` + cause —
   never silently missing (SC-002).
3. Deterministic metrics are identical across identical runs (D10; SC-004).
4. Under `--keyless`, no network AI call is attempted; a missing pinned response fails the affected
   case (`TRANSCRIPT_MISS`) and the run exits 2 (D4).
