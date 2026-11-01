# Benchmarks (specs/009-evaluation-benchmark)

Run with `npm run benchmark -- [flags]` — one command evaluates generation quality over the version-controlled fixture set, compares against the pinned baseline, and
gates automation via exit codes (`0` pass · `1` regressed · `2` incomplete · `3` config/infra error).

## Layout

- `benchmark.config.json` — defaults (`spendCapUsd`, mode, compare); CLI flags override per task key
- `fixtures/` — the version-controlled fixture set: `manifest.json` (cases + expected
  characteristics), `profiles/` (structured FR/EN profiles),
  `jds/` (FR/EN job descriptions). Editing any byte changes the fixture-set version hash and
  invalidates old baselines.
- `baselines/` — **committed source**. One `<fixtureSetVersion>.json` per fixture-set version,
  written ONLY via `npm run benchmark -- --update-baseline` (records `pinnedAt`/`pinnedBy`/models).
  Never hand-edit. Baselines also pin a `promptSetVersion` content hash of
  `src/lib/llm/prompts/*.md` — a run whose prompts differ from the pinned ones is skipped with a
  re-pin instruction (prompt changes require re-baselining; see that directory's README).
- `runs/` — retained run reports, one directory per run (`report.json`, `summary.md`,
  `comparison.md` when a baseline existed). Gitignored local artifacts — delete freely.
- `transcripts/` — pinned AI responses per fixture-set version (`<version>/<taskId>.jsonl`),
  produced by `--record`, consumed by `--keyless`. Committed.

## Rules of thumb

- The benchmark runs against the dedicated `profileforge_benchmark` database (it refuses to boot
  against anything else) and never touches real user data. Live runs cost real money —
  `--cap` (default `$1.00`) aborts with exit `2`.
- Baselines change only through `--update-baseline` on a complete, non-partial run.
- Deterministic metrics are zero-tolerance (any change from baseline is a regression);
  model-dependent metrics use the bands in `specs/009-evaluation-benchmark/contracts/metrics.md`.
- `--keyless` evaluates the deterministic stages only (matching, selection, render verification)
  using pinned transcripts — the report says so explicitly. Replay requires the same `--models`
  mapping as the recording run (the transcript identity includes the model).
- Full flag reference: [specs/009-evaluation-benchmark/contracts/cli.md](../specs/009-evaluation-benchmark/contracts/cli.md).
