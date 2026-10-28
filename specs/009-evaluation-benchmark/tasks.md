# Tasks: Evaluation Benchmark (009)

**Input**: Design documents from `/specs/009-evaluation-benchmark/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included — plan.md's Technical Context names the Vitest unit/integration files, and the
spec's success criteria (SC-002…SC-007) require verification. Tests run under the existing suites
(`npm test`), which mock LLM tasks and use the `profileforge_test` database; no benchmark task may
require real credentials or touch any database whose URL does not name `profileforge_benchmark`
(the workspace guard, T007, enforces this in production runs — tests must respect it too).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing
of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions

Single project (existing repo): benchmark library under `src/lib/benchmark/`, CLI entry under
`scripts/`, data under `benchmarks/`, tests under `tests/unit/` and `tests/integration/` — exactly
the layout in plan.md → Project Structure.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Wire the entry point and prepare the benchmark data area.

- [x] T001 Add `benchmark` script (`tsx scripts/run-benchmark.ts`) to package.json scripts
- [x] T002 [P] Add `benchmarks/runs/` and `uploads-benchmark/` to .gitignore (run reports and benchmark uploads are local artifacts; baselines, fixtures, and transcripts stay committed)
- [x] T003 [P] Create the benchmark data scaffold: `benchmarks/benchmark.config.json` (defaults per data-model.md §1: `mode: "live"`, `spendCapUsd: 1.00`, `compare: true`), `benchmarks/baselines/README.md` (committed baselines only; change exclusively via `--update-baseline`), `benchmarks/runs/.gitkeep`, `benchmarks/transcripts/README.md` (per fixture-set-version transcript files)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Config, fixtures, and isolation — nothing user-story-shaped can run without these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 Implement BenchmarkConfig schema + load/merge (flags > `benchmarks/benchmark.config.json` > defaults) in `src/lib/benchmark/config.ts` — zod schema per data-model.md §1: `mode` `"live"|"replay"`, `models` `Partial<Record<TaskId, string>>` (keys must be registered LLM task ids), `spendCapUsd` number > 0 default 1.00, `compare` boolean default true, `updateBaseline` boolean default false, `label` string optional, `caseIds` string[] optional; invalid config ⇒ exit-code-3 error type
- [x] T005 [P] Implement fixture-set loading + content-hash versioning + completeness validation in `src/lib/benchmark/fixtures.ts` — `version` = content hash of manifest + every fixture/variant file; validation failures (exit-3 class): ≥ 2 profiles covering EN and FR with ≥ 1 edge profile, ≥ 3 JDs covering EN and FR incl. hard-constraint-heavy and poor-match, every case references existing profile/jd ids, every variant class of the 5 (`altered_number`, `altered_date`, `fabricated_entry`, `meaning_drift`, `unverified_skill`) present, `expected` characteristics are machine-checkable fields
- [x] T006 [P] Author the fixture set per data-model.md §2 and research.md D12 under `benchmarks/fixtures/`: `manifest.json` (cases as (profileId, jdId, outputLanguage) triples with machine-checkable `expected`), `profiles/en-standard.json` + `profiles/fr-thin-dates.json` (structured profile-draft JSON; the FR one deliberately thin with date-ambiguous content), `jds/en-hard-constraints.txt`, `jds/en-standard.txt`, `jds/fr-poor-match.txt`, `variants.json` (5 variant defs with target selectors and `expected: { blocked: true, caughtBy }` — `meaning_drift` expects `caughtBy: "semantic"`, all others `"deterministic"`)
- [x] T007 Implement the benchmark workspace in `src/lib/benchmark/workspace.ts` — hard DB URL guard: refuse to boot (exit-3 error) unless `DATABASE_URL`/`BENCHMARK_DATABASE_URL` names the `profileforge_benchmark` database (same abort pattern as `tests/e2e/scripts/reset-db.mjs`); schema reset + `prisma migrate deploy`; force `UPLOADS_DIR=./uploads-benchmark`; create a fresh synthetic benchmark user per run (owner of all run rows)
- [x] T008 [P] Unit tests for config precedence and validation in `tests/unit/benchmark-config.test.ts` — flag > file > default for every field; unknown model task key rejected; `spendCapUsd: 0` and negative rejected (depends on T004)
- [x] T009 [P] Unit tests for fixture-set validation in `tests/unit/benchmark-fixtures.test.ts` — minimum counts, dangling case reference rejected, missing variant class rejected, version hash stable for identical content and changed for any byte edit (depends on T005, T006)
- [x] T010 [P] Integration test for the workspace in `tests/integration/benchmark-workspace.test.ts` — boot refuses a URL naming `profileforge_test`/`profileforge` (exit-3 error type), accepts only `profileforge_benchmark`, resets schema idempotently, creates a fresh synthetic user per invocation (depends on T007)

**Checkpoint**: Foundation ready — config, fixtures, and an isolated, guarded workspace exist.

---

## Phase 3: User Story 1 — One-command run with a reproducible report (Priority: P1) 🎯 MVP

**Goal**: `npm run benchmark` executes the real pipelines over every fixture case in an isolated
workspace and writes a complete, reproducible `report.json` + `summary.md` with verdict scaffolding.

**Independent Test**: Run the benchmark (LLM tasks mocked in test, real key in live use); the report
covers 100% of cases with per-metric values and run metadata; two identical runs produce identical
deterministic metric values.

### Tests for User Story 1

> Write these first; they must FAIL before the implementation tasks below land.

- [x] T011 [P] [US1] Unit tests for deterministic quality metrics in `tests/unit/benchmark-metrics.test.ts` — synthetic SelectionRecord/omissions/generated-content/fit/verify artifacts covering true and false paths for `selection_integrity` (draft ∪ omissions covers whole profile), `omissions_reasoned` (every omission reason ∈ {`selection`, `page_budget`}), `summary_length_ok` (within configured 30–120 words), `page_budget_ok`, `output_language_ok`, `extraction_gate_ok`; rates quantized to 4 decimals; normalized (sorted) inputs so ordering never changes a value
- [x] T012 [P] [US1] Integration test for the full runner in `tests/integration/benchmark-runner.test.ts` — against `profileforge_benchmark` with mocked LLM tasks: every manifest case yields a CaseResult (`ok` or `failed` + `{stage, cause}`, never missing), report conforms to `profileforge.benchmark.report/1`, metadata present (fixtureSetVersion, models, codeState, spendUsd, durationMs), and two consecutive runs have byte-identical deterministic metric values

### Implementation for User Story 1

- [x] T013 [P] [US1] Implement the deterministic quality metrics listed in T011 in `src/lib/benchmark/metrics.ts` — computed only from persisted pipeline artifacts (MatchReport, SelectionRecord, omissions, generated version, fit result, verify result, usage log via `getRunUsage`); no AI calls (FR-008)
- [x] T014 [US1] Implement the case runner in `src/lib/benchmark/runner.ts` — per case: seed profile via `importFromDraft` → `createAnalysis` → extract (`storeExtractedRequirements`) → `matchRequirements` + `persistReport` → `createGenerationJob` + `runGenerationJob` + `waitForJobSettled` for `cv` and `cover_letter`; collect artifacts per stage; a stage failure records `failed` + cause on the CaseResult and continues with remaining cases (FR-003, SC-002)
- [x] T015 [US1] Implement report assembly + persistence in `src/lib/benchmark/report.ts` and `src/lib/benchmark/store.ts` — `report.json` exactly per contracts/metrics.md §Report (schema string, verdict field present, `partial` flag), every case present, `notes[]` for stated caveats; runs written to `benchmarks/runs/<runId>/` with `runId = <UTC timestamp>-<label-or-slug>`; `summary.md` renderer (verdict, per-case metrics table, spend/duration); `spend_usd`/`duration_ms` informational only
- [x] T016 [US1] Wire the CLI in `scripts/run-benchmark.ts` — boot order: config (T004) → fixtures (T005) → workspace guard (T007) before any AI call; run cases (T014), measure (T013), assemble + persist (T015); flags `--label`, `--case` (subset ⇒ `partial: true`, verdict can never be `pass`), `--json` (machine summary on stdout); exit 0 on pass, exit 3 on config/infrastructure error (T001's script must now work end-to-end)

**Checkpoint**: `npm run benchmark` produces a complete, reproducible report; US1 verifiable
independently (this is the MVP).

---

## Phase 4: User Story 2 — Zero-invention measurement & Fact Guard effectiveness (Priority: P1)

**Goal**: The report quantifies the guarantee: grounded-claim rate, per-class corrupted-variant
catch rates, and fail-closed verification.

**Independent Test**: Run the benchmark; the Fact Guard section shows grounded-claim rate per case,
each corrupted variant `blocked ∧ caughtBy = expected`, and `fail_closed_verified = true`.

### Tests for User Story 2

- [x] T017 [P] [US2] Unit tests for variant mutation in `tests/unit/benchmark-variants.test.ts` — each of the 5 classes produces exactly its intended change (number altered, date altered, fabricated entry added, meaning-drifted rewrite, unverified skill introduced) against a representative generated CV version, and nothing else
- [x] T018 [P] [US2] Integration test for variant evaluation in `tests/integration/benchmark-variants.test.ts` — shipped Fact Guard validation over mutated copies: the 4 deterministic classes always blocked with the expected blocker class; `meaning_drift` blocked via the semantic layer (mocked task); `computeDownloadable` refuses all formats for every blocked copy; forced-unavailable meaning-check layer ⇒ nothing downloadable (fail-closed drill)

### Implementation for User Story 2

- [x] T019 [US2] Implement corrupted-variant mutation for all 5 classes from `variants.json` selectors in `src/lib/benchmark/variants.ts` (in-memory copies only — persisted versions are never modified)
- [x] T020 [US2] Implement variant evaluation in `src/lib/benchmark/variants.ts` — run the shipped Fact Guard validation over each copy, assert `blocked ∧ caughtBy = expected` (a deterministic-class miss is a failed expectation), collect `VariantResult { variantId, blocked, caughtBy, expectedCaughtBy, pass }`
- [x] T021 [US2] Add the Fact Guard metrics to `src/lib/benchmark/metrics.ts` — `grounded_claim_rate` (final version validation report vs profile snapshot; shortfalls listed as claim refs), `deterministic_catch_rate` (4 classes; required 1.0000), `semantic_catch_rate` (`meaning_drift`; model_dependent), `fail_closed_verified` (drill: force meaning-check unavailable ⇒ `computeDownloadable` refuses every format)
- [x] T022 [US2] Fold variant results + new metrics into the runner and report in `src/lib/benchmark/runner.ts` and `src/lib/benchmark/report.ts` — `variantResults` per case, `groundedClaimShortfalls` per case, and the SC-003 invariant: any deterministic violation passing undetected ⇒ verdict can never be `pass`

**Checkpoint**: US1 + US2 both work independently; the report now measures the zero-invention
guarantee end-to-end.

---

## Phase 5: User Story 3 — Baseline comparison & regression gating (Priority: P2)

**Goal**: Runs compare against a pinned baseline with per-metric thresholds and gate automation via
exit codes.

**Independent Test**: Pin a baseline; degrade a prompt/model so a metric crosses its threshold;
rerun ⇒ exit 1 with the exact metric/fixture flagged; restore ⇒ exit 0.

### Tests for User Story 3

- [x] T023 [P] [US3] Unit tests for comparison + verdict in `tests/unit/benchmark-compare.test.ts` — deterministic metrics: any difference is a regression (zero tolerance); model_dependent thresholds from contracts/metrics.md verbatim (`requirement_coverage` ≥ baseline − 0.05 AND ≥ 0.80; `grounded_claim_rate` ≥ baseline − 0.03 AND ≥ 0.97; `semantic_catch_rate` ≥ baseline − 0.10 AND ≥ 0.50) incl. boundary values; missing baseline ⇒ `comparison: skipped` + reason (not an error); fixture-set-version mismatch ⇒ skipped with reason; verdict invariants: `pass` requires status complete ∧ ¬partial ∧ all cases ok ∧ no regression ∧ all deterministic expectations, otherwise `regressed`/`incomplete`

### Implementation for User Story 3

- [x] T024 [US3] Implement baseline persistence in `src/lib/benchmark/store.ts` (extend) — load/pin `benchmarks/baselines/<fixtureSetVersion>.json` with `pinnedAt`, `pinnedBy` (from `--label` or "unspecified"), `codeState`, effective `models`, per-case metric values, `dictionaryVersion: "v1"`
- [x] T025 [US3] Implement the comparison engine + verdict computation in `src/lib/benchmark/report.ts` — per-metric `MetricResult.comparison` semantics from T023; aggregate `comparison` outcome + `notes` reasons; verdict per data-model.md invariants (SC-003 override included)
- [x] T026 [US3] Map verdicts to exit codes in `scripts/run-benchmark.ts` — `pass` ⇒ 0, `regressed` ⇒ 1, `incomplete` ⇒ 2 (spend cap, provider failure, all-cases-failed), config/infra ⇒ 3; comparison skipped never changes the verdict
- [x] T027 [US3] Wire `--update-baseline` (requires `status == complete` and `partial == false`, else exit 3; writes the baseline file) and `--no-compare` in `scripts/run-benchmark.ts`

**Checkpoint**: The benchmark gates — regression drill from quickstart Scenario D passes.

---

## Phase 6: User Story 4 — Model-swap evaluation (Priority: P2)

**Goal**: A candidate model configuration can be benchmarked and compared side-by-side with the
baseline configuration without re-running it.

**Independent Test**: Run with `--models <task>=<candidate>`; the report records the mapping, and
its summary compares quality, `semantic_catch_rate`, `spend_usd`, and `duration_ms` per case
against the baseline run from retained history.

### Tests for User Story 4

- [x] T028 [P] [US4] Unit tests for `--models` parsing in `tests/unit/benchmark-cli-flags.test.ts` — `task=model` pairs merge over config file per precedence; unknown task id ⇒ exit-3 error; malformed pair ⇒ exit-3 error; merged mapping surfaces in effective config (depends on T004)

### Implementation for User Story 4

- [x] T029 [US4] Implement `--models` end-to-end in `scripts/run-benchmark.ts` and `src/lib/benchmark/runner.ts` — effective mapping written into the synthetic user's settings via `updateSettings` before any case runs (so `callLLM`'s per-task resolution uses it); mapping recorded verbatim in `report.config.models`
- [x] T030 [US4] Implement side-by-side comparison in the `summary.md` renderer (`src/lib/benchmark/report.ts`) — given two retained run reports (current + baseline-pinned or named), render per-case rows: each metric, `semantic_catch_rate`, `spend_usd`, `duration_ms` for both runs (SC-006)

**Checkpoint**: quickstart Scenario E (model-swap comparison) passes.

---

## Phase 7: User Story 5 — Keyless deterministic mode (Priority: P3)

**Goal**: Without credentials, the benchmark still exercises all deterministic stages via pinned
recorded AI responses, clearly labeled "deterministic stages only".

**Independent Test**: With no AI credentials configured, `npm run benchmark -- --keyless` completes
over the whole fixture set, exercises matching/selection/deterministic Fact Guard/render
verification, and the report is unmistakably labeled as deterministic-only.

### Tests for User Story 5

- [x] T031 [P] [US5] Unit tests for transport + transcripts in `tests/unit/benchmark-transcripts.test.ts` — live passthrough is behavior-identical to the current router path; record appends `{taskId, inputHash, model, response, usage}`; replay returns the pinned response for the same `inputHash` and raises `TRANSCRIPT_MISS` otherwise (never synthesizes); `inputHash` stable across identical (payload, model) and sensitive to any change

### Implementation for User Story 5

- [x] T032 [US5] Implement the injectable transport (live | record | replay) in `src/lib/llm/transport.ts` and wire it into `callLLM` in `src/lib/llm/router.ts` additively — the default live path must remain byte-identical in behavior (constitution re-check); replayed responses feed the existing usage accounting
- [x] T033 [US5] Implement the transcript store in `src/lib/benchmark/transcripts.ts` — append-only JSONL during record, read-only lookup during replay, under `benchmarks/transcripts/<fixtureSetVersion>/<taskId>.jsonl`
- [x] T034 [US5] Wire `--keyless` and `--record` in `scripts/run-benchmark.ts` — `--keyless` forces `mode=replay`, requires no credentials, sets `report.keylessMode = true` and labels the summary "deterministic stages only"; `TRANSCRIPT_MISS` ⇒ affected case `failed` + run `incomplete` + exit 2; `--record` does a live run and appends transcripts for the current fixture-set version

**Checkpoint**: quickstart Scenario A passes with credentials unset.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, regression safety, and recorded verification.

- [x] T035 [P] Document the benchmark: add a "Benchmark" subsection to the Tests area of `README.md` (`npm run benchmark`, live vs `--keyless`, ≤ 15 min / ≤ $1.00 budget, exit codes) and create `benchmarks/README.md` (directory layout, baseline rules: committed, changed only via `--update-baseline`, runs gitignored)
- [x] T036 Verify the product is untouched: `npm run lint` (0 errors), `npm test` (all green incl. new benchmark tests), `npm run build`, and `npm run test:e2e` still 45 passed / 1 key-gated skip — no changes to pages, API routes, or Prisma schema anywhere in the diff
  > **T037 status (2026-10-28, partial):** keyless loud-miss path verified live (exit 2, TRANSCRIPT_MISS per case — nothing synthesized); live `--record` over all 4 cases ran ~90% but two
  > failures surfaced: (1) substring variant needles did not survive live translation — FIXED
  > (needles now translation-stable numbers), (2) OpenRouter free-tier **daily cap exhausted**
  > ("free-models-per-day"). Resume after cap reset (or with credits): re-run `--record` (all 4 cases,
  > same model mapping), then keyless ×2 (Scenario A + SC-004), `--update-baseline` (C), live drills (D/E).
- [ ] T037 Execute `specs/009-evaluation-benchmark/quickstart.md` scenarios A–G in order and record outcomes (verdicts, exit codes, report paths) in the task completion notes; confirm SC-001 (≤ 15 min, ≤ $1.00 on the live run) and SC-003 (deterministic catch rate 1.0000) from actual report contents
- [x] T038 Update the top-level status docs to reflect slice 009: `ProfileForge-Specification.md` Current Status table (+ Evaluation module no longer "not started" once done), `CONSOLIDATION.md` §1 inventory row (009 status + tasks count), `README.md` status line (link `specs/009-evaluation-benchmark`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately (T002, T003 parallelizable)
- **Foundational (Phase 2)**: depends on Phase 1; BLOCKS all user stories (config T004, fixtures T005/T006, workspace T007)
- **US1 (Phase 3)**: depends on Phase 2 — MVP; delivers the runnable benchmark + reports
- **US2 (Phase 4)**: depends on US1's runner/metrics surfaces (T013–T015); extends them
- **US3 (Phase 5)**: depends on US1 (reports) and US2 (Fact Guard metrics are part of the compared set)
- **US4 (Phase 6)**: depends on US3 (side-by-side uses baseline/retained runs; threshold semantics)
- **US5 (Phase 7)**: depends on US1 (runner) — independent of US2–US4 in principle; placed last per priority (P3)
- **Polish (Phase 8)**: depends on all desired stories being complete

### User Story Dependencies

- **US1**: foundational only — no cross-story dependencies
- **US2**: builds on US1's runner + metrics module; independently testable once US1 lands
- **US3**: needs US1's reports; Fact Guard metrics from US2 are in the compared dictionary
- **US4**: needs US3's baseline/retained-run semantics for side-by-side
- **US5**: needs US1's runner; its router change (T032) is independent of US2–US4 code paths

### Within Each User Story

- Tests first (they must FAIL before the implementation tasks of that story)
- Metrics/units before orchestration; orchestration before CLI wiring; story complete before next priority

### Parallel Opportunities

- Phase 1: T002 ∥ T003
- Phase 2: T005 ∥ T006 ∥ (T004 → T008) and (T007 → T010) streams
- Within US1: T011 ∥ T012 (tests), then T013 ∥ T014 (metrics ∥ runner), then T015 → T016
- Within US2: T017 ∥ T018 (tests), then T019 → T020 ∥ T021, then T022
- US5's T032 (router transport) can proceed while US3/US4 work continues — different files
- Different user stories can proceed in parallel once US1 lands (US2 immediately; US3 after US2's metric set is final)

---

## Parallel Example: User Story 1

```bash
# Launch the two test streams together (mocked LLM, benchmark DB only):
Task: "Unit tests for deterministic quality metrics in tests/unit/benchmark-metrics.test.ts"
Task: "Integration test for the full runner in tests/integration/benchmark-runner.test.ts"

# Then the two implementation streams together:
Task: "Deterministic quality metrics in src/lib/benchmark/metrics.ts"
Task: "Case runner in src/lib/benchmark/runner.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1
4. **STOP and VALIDATE**: `npm run benchmark` produces a complete, reproducible report (quickstart
   Scenario B's coverage/reproducibility checks); mocked-LLM integration test green
5. This alone replaces "quality is whatever the last manual run looked like" with a recorded,
   comparable artifact

### Incremental Delivery

- +US2 → the report measures the zero-invention guarantee (the product's core promise)
- +US3 → the run becomes a gate (exit codes + baselines committed for review)
- +US4 → model swaps become evidence-based decisions
- +US5 → the harness runs in credential-less environments (fresh clones, automation)

Each increment keeps prior stories green — no story modifies another story's metric semantics.

### Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Every AI-touching test uses the existing Vitest LLM mocks or recorded transcripts — never real
  credentials, never a non-benchmark database
- Commit after each task or logical group (repo convention: Conventional Commits, only when asked)
- Avoid: changing product behavior in any task; the only product-code contact in this whole list is
  T032's additive transport injection
