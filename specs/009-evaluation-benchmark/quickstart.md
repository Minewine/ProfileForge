# Quickstart: Evaluation Benchmark (009)

Validation scenarios proving the slice works end-to-end. Each scenario maps to spec success
criteria. Design details live in [plan.md](./plan.md), [data-model.md](./data-model.md), and
[contracts/](./contracts/).

## Prerequisites

- Repo checked out; `npm install` done (npm ≥ 11); `docker compose up -d` (Postgres instances).
- Live scenarios need `OPENROUTER_API_KEY` in `.env` (or environment). Scenario A needs none.
- The benchmark database (`profileforge_benchmark`) is created/reset by the harness itself — never
  point it at `profileforge` or `profileforge_e2e` (it refuses and exits 3).

## Scenario A — Keyless deterministic run (SC-007; FR-014)

```bash
npm run benchmark -- --keyless
```

Expected: completes in ≤ 2 minutes **without any AI credentials**; exit code 0 (first run: no
baseline yet ⇒ verdict `pass`, `comparison: skipped` with reason stated). The report
(`benchmarks/runs/<runId>/summary.md`) is labeled **"deterministic stages only"** and shows:
`selection_integrity`, `omissions_reasoned`, `summary_length_ok`, `page_budget_ok`,
`output_language_ok`, `extraction_gate_ok`, `deterministic_catch_rate = 1.0000`,
`fail_closed_verified = true` for every case. Model-dependent metrics are absent (not zero).

## Scenario B — Live run, reproducibility, coverage (SC-001, SC-002, SC-004)

```bash
npm run benchmark
npm run benchmark -- --label repeat-check
```

Expected: each run ≤ 15 minutes, spend ≤ $1.00 (printed in the report); exit 0. The two reports'
deterministic metrics are **byte-identical**; every manifest case appears in both (failures would
be recorded as `failed` + cause, never missing). Run B again with the key unset and no `--keyless`:
exits 3 at boot (credentials required for live mode) — no partial artifacts.

## Scenario C — Baseline pinning and explicit update (FR-012)

```bash
npm run benchmark -- --update-baseline --label "first baseline"
git status benchmarks/baselines/
```

Expected: `benchmarks/baselines/<fixture-set-version>.json` created, containing `pinnedAt`,
`pinnedBy` ("first baseline"), `codeState`, and per-case metric values. Re-running with plain
`npm run benchmark` now compares against it (`comparison: ok`).

## Scenario D — Regression detection (SC-005; FR-010/FR-011)

1. Temporarily degrade a prompt in `src/lib/llm/tasks/` (e.g., drop a fact-guard instruction) or
   set `--models generatetailoredcv=<a cheaper model>`.
2. `npm run benchmark -- --label regression-drill`

Expected: exit code 1; summary lists the regressed metric(s) per case first (e.g.,
`grounded_claim_rate` below threshold, or a `deterministic_catch_rate` miss with the variant id);
`verdict: regressed`. Revert the change; re-run ⇒ exit 0.

## Scenario E — Model-swap comparison (SC-006; US4)

```bash
npm run benchmark -- --models generatetailoredcv=<candidate-model> --label candidate-a
```

Expected: report records the candidate mapping per task; comparing its report with the baseline
run side-by-side shows quality metrics, `semantic_catch_rate`, `spend_usd`, and `duration_ms` per
case — without re-running the baseline.

## Scenario F — Spend cap abort (FR-013)

```bash
npm run benchmark -- --cap 0.01
```

Expected: run aborts once spend exceeds one cent; report `verdict: incomplete` stating
spend-so-far; exit code 2. No `pass` verdict is possible.

## Scenario G — Fail-closed drill visibility (FR-006)

Open any live report: `fail_closed_verified = true` per case — the drill (meaning-check layer
forced unavailable ⇒ `computeDownloadable` refuses every format) ran inside the benchmark and is
reported, not assumed.

## Final gate (matches repo conventions)

- `npm run lint` — 0 errors
- `npm test` — all green, including new `tests/unit/benchmark-*` and `tests/integration/benchmark-*`
- `npm run build` — unaffected (benchmark adds no App Router surface)
- Existing e2e suite untouched: `npm run test:e2e` still 45 passed / 1 key-gated skip

## Cleanup

Runs accumulate under `benchmarks/runs/` (gitignored) — delete freely. Baselines are committed
source: change them only via `--update-baseline` (recorded), never by hand.
