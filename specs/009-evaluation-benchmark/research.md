# Research: Evaluation Benchmark (009)

Phase 0 output. All unknowns were resolved against the actual codebase during the 2026-10-28
consolidation scan and a targeted symbol check of `src/lib/**`; no open NEEDS CLARIFICATION items
remain. Each decision below records: Decision / Rationale / Alternatives considered.

## D1. Harness invocation: direct lib composition via a tsx script

- **Decision**: `scripts/run-benchmark.ts` (tsx) imports the shipped `src/lib` functions and drives
  them directly against the benchmark database. No HTTP server, no test-runner coupling.
- **Rationale**: FR-003 requires measuring the real, unmodified pipelines. The substance of the
  product lives in `src/lib` (`runGenerationJob`, `matchRequirements`, `runExtractionGate`, …);
  API routes add only auth/validation on top. Direct composition runs the identical code paths
  with no server lifecycle to manage, keeps timing/cost attribution exact, and matches the repo's
  existing script pattern (`scripts/assign-owner.ts`).
- **Alternatives**: (a) HTTP against `next start` — couples the benchmark to server startup,
  session cookies, and route-level auth; slower and flakier, measures the same lib code anyway.
  (b) Drive everything through Playwright — measures UI, not required here; feature 004 already
  covers UI journeys. (c) vitest-driven benchmark — conflates "run a benchmark" with "run tests";
  benchmark needs its own exit codes, spend accounting, and retained reports.

## D2. Data isolation: dedicated database + uploads dir with a hard URL guard

- **Decision**: The harness derives `DATABASE_URL` to the `profileforge_benchmark` database
  (env `BENCHMARK_DATABASE_URL` override), aborts unless the URL names that database (same
  safety pattern as `tests/e2e/scripts/reset-db.mjs`), drops/recreates the schema per run
  (`prisma migrate deploy` after a schema reset), and uses `UPLOADS_DIR=./uploads-benchmark`.
  A fresh synthetic benchmark user owns all rows for the run.
- **Rationale**: FR-003 forbids touching real user data. Physical isolation is the repo's
  proven pattern (`profileforge_test`, `profileforge_e2e`); a URL guard makes wrong-database
  mutation impossible rather than unlikely. A per-run fresh user means no cross-run state leaks
  into metrics.
- **Alternatives**: logical isolation by user id inside the dev database — rejected: one bad
  query path away from real data; the consolidation already flags code-level scoping as the
  isolation mechanism, so the benchmark must not add another writer to the live DB.

## D3. Model configuration: reuse the per-user settings store

- **Decision**: The runner writes the run's model mapping (task → model id) into the synthetic
  user's `AppSettings` via `updateSettings` before executing cases; `callLLM`'s existing
  per-task/per-user resolution then uses exactly the configured models. `OPENROUTER_API_KEY`
  comes from the environment (keyStore's env-first resolution).
- **Rationale**: FR-004 requires explicit, per-task model configuration independent of any real
  user's settings — a throwaway user whose settings ARE the run config achieves this with zero
  router changes. Settings-stored keys are unnecessary; the benchmark always runs from env.
- **Alternatives**: threading a model override parameter through `callLLM` — larger diff in
  product code for no benefit; environment-variable model overrides — implicit and per-task
  mapping would be awkward.

## D4. Live/record/replay transport behind the router (keyless mode)

- **Decision**: Extract the router's HTTP call into an injectable transport
  (`src/lib/llm/transport.ts`): `live` (default, current behavior), `record` (live call +
  append `{taskId, inputHash, model, response, usage}` to the run's transcript file), `replay`
  (serve the pinned response for `taskId + inputHash`, fail with `TRANSCRIPT_MISS` if absent —
  never synthesize). `--keyless` runs with `replay` and no credentials.
- **Rationale**: FR-014 needs deterministic stages exercised without credentials; replay keyed by
  input hash guarantees the same prompts hit the same pinned responses, so deterministic-stage
  metrics are reproducible. The change to `router.ts` is additive and behavior-preserving
  (constitution re-check PASS).
- **Alternatives**: global `fetch` mock inside the harness — leaks abstraction, wouldn't
  reproduce router-level economy/premium resolution and usage accounting; snapshot-testing the
  router instead of replaying — measures nothing about the downstream stages.

## D5. Corrupted variants: in-memory claim mutation + real Fact Guard re-evaluation

- **Decision**: After a case's CV version is generated and validated, `variants.ts` derives
  corrupted copies in memory per `variants.json` (classes: `altered_number`, `altered_date`,
  `fabricated_entry`, `meaning_drift`, `unverified_skill`), runs the real Fact Guard validation
  over each copy, and asserts the expected blocker class fires and `computeDownloadable`
  reports not-downloadable. `meaning_drift` additionally exercises the semantic layer
  (replayable via transcripts).
- **Rationale**: FR-006/FR-007 need per-class catch rates against labeled violations; mutating
  real generated content and re-running the shipped Fact Guard is the honest measurement — it
  tests the gate exactly as production runs it.
- **Alternatives**: hand-authored fake documents — wouldn't exercise provenance resolution
  against a real profile snapshot; corrupting at render level — measures the wrong layer.

## D6. Metrics derive only from persisted artifacts (FR-008)

- **Decision**: `metrics.ts` computes all 12 metrics from artifacts the pipeline already persists:
  MatchReport (`requirement_coverage`), generated version content + profile snapshot + Fact Guard
  validation report (`grounded_claim_rate`), SelectionRecord + omissions (`selection_integrity`,
  `omissions_reasoned`), summary length setting (`summary_length_ok`), franc detection on output
  text (`output_language_ok`), final page count (`page_budget_ok`), extraction-gate result
  (`extraction_gate_ok`), variant evaluation (`deterministic_catch_rate`, `semantic_catch_rate`),
  fail-closed drill (`fail_closed_verified`), plus informational `spend_usd`/`duration_ms` from
  `getRunUsage`. No metric triggers a new AI call.
- **Rationale**: Keeps measurement deterministic and auditable (every value traceable to a stored
  artifact) and adds zero inference cost.
- **Alternatives**: LLM-as-judge scoring — explicitly out of scope in the spec.

## D7. Baselines, runs, and identity

- **Decision**: `benchmarks/baselines/<fixture-set-version>.json` is committed and holds the
  designated reference values + thresholds per metric; `benchmarks/runs/<runId>/report.json` is
  retained per run (gitignored). `fixtureSetVersion` = content hash of `manifest.json` + all
  fixture/variant files; editing any fixture invalidates old baselines automatically
  (comparison refuses on version mismatch, per spec edge case). Code state = `git rev-parse
  --short HEAD` + dirty flag, captured at run start.
- **Rationale**: Baselines must be reviewable in PRs (they encode expected quality); runs are
  evidence, not source. Content-hash versioning makes stale-baseline detection structural, not
  manual. FR-012's "explicit, recorded update" = a committed baseline file change.
- **Alternatives**: database-stored baselines — not reviewable, not portable; latest-run-as-
  baseline (ratchet) — lets regressions accumulate silently, rejected in favor of explicit pins.

## D8. Verdict semantics and exit codes

- **Decision**: verdict ∈ `pass | regressed | incomplete`; exit codes: `0` pass, `1` regressed,
  `2` incomplete (abort, provider failure, transcript miss, cap hit), `3` configuration/infrastructure
  error (bad flags, wrong DB, missing fixtures). Comparison skip (no baseline for version) is
  reported but does not change the verdict — the run itself was clean.
- **Rationale**: Maps FR-009/FR-011/FR-013 onto automatable semantics while keeping "couldn't
  measure" distinct from "measured worse" — conflating them would make the gate noisy.

## D9. Spend cap

- **Decision**: `--cap <usd>` (default 1.00, schema-validated > 0). The runner consults the
  existing per-run usage accumulation (`checkRunCap` semantics) before each AI-touching stage;
  on exceed it aborts, marks affected cases failed, writes an incomplete report stating
  spend-so-far, exits `2`.
- **Rationale**: FR-013. The in-memory accumulation is adequate here by construction — a run is
  a single process invocation, so the restart-reset gap flagged in CONSOLIDATION.md cannot bite.

## D10. Determinism rules for comparison

- **Decision**: Deterministic-category metrics must be byte-identical across identical runs:
  they are computed with normalized ordering (sorted keys/ids), no timestamps, and integer/decimal
  quantization (rates at 4 decimal places). Model-dependent metrics compare via thresholds only
  (SC-004/edge case). `--no-compare` skips comparison explicitly.
- **Rationale**: SC-004 requires exact reproducibility; any hidden ordering or float noise would
  produce phantom regressions and destroy trust in the gate.

## D11. No new runtime dependencies

- **Decision**: All functionality uses existing deps (zod, prisma, franc, pdf/docx libs, tsx).
- **Rationale**: The harness composes measured systems; adding libraries would expand the trusted
  surface the benchmark is supposed to be guarding. Report rendering is plain JSON + a small
  markdown summary writer.

## D12. Fixture authoring

- **Decision**: Profiles are structured JSON conforming to the profile schema (imported via
  `importFromDraft`, same as parsed imports); JDs are raw text (FR + EN); `manifest.json` declares
  cases as (profile, jd, outputLanguage) triples with expected characteristics (e.g.,
  `hard_constraints_expected`, `expected_weak_match`) that metrics use as assertions, not prose.
  Minimum set per FR-002: 2 profiles (one EN, one FR with thin/date-ambiguous content), 3 JDs
  (hard-constraint-heavy EN, standard EN, poor-match FR), 5 variant classes.
- **Rationale**: Structured fixtures match the spec's "profile + JD fixtures" scope (parse
  excluded) and reuse the import path that production data takes; expected characteristics make
  the manifest the single source of truth for what a "pass" means per fixture.
