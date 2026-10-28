---
description: "Task list for feature implementation"
---

# Tasks: Polish & Reliability Slice (feature 006)

**Input**: Design documents from `/specs/006-polish-reliability/` — plan.md (decisions R1–R6, structure), spec.md (US1–US4, FR-001–FR-011, SC-001–SC-004), research.md (R1–R6 with file:line evidence), data-model.md (derived view entities — NO schema change), contracts/error-messages.md (per-code message/action matrix), contracts/fact-guard-ux.md (gate-state text + flag explanations + completeness guard), contracts/ui-states.md (progress/loading/disabled contract), quickstart.md (validation scenarios).

**Prerequisites**: Feature 005 complete and green (303 vitest + 15 e2e). Inherited binding constraints: fail-closed Fact Guard semantics UNTOUCHED (messages/presentation only), stored-artifact downloads (no re-render on download), server messages are the single source of truth, client components must not import modules pulling `node:crypto`/`@prisma`. Workspace rule: consult `node_modules/next/dist/docs/` before touching Next.js APIs.

**Tests**: Included — tests-first per the established slice convention (write the suite, watch it fail, then implement). One exception documented in-place: the US4 export matrix is a verification suite that may pass on arrival; its task is to confirm and close any gap it exposes.

**Organization**: Foundational (shared client message module) → US1 (failure messages, P1) → US2 (blocked-export UX, P1) → US3 (progress, P2) → US4 (dual-template export, P2) → Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1…US4)
- Exact file paths in every description; strings quoted verbatim from the contracts

---

## Phase 1: Setup

No setup phase — the feature adds no infrastructure, dependencies, or configuration. Work begins at Foundational.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared client-safe message module (research R6) that US1 and US2 both consume.

- [x] T001 Unit suite for the shared client message module in `tests/unit/client-messages.test.ts` — watch it fail, then keep as the contract guard. Assertions: (a) `LLM_ERROR_GUIDANCE` has exactly the keys `LLM_KEY_INVALID | LLM_QUOTA | LLM_RATE_LIMITED | LLM_UNAVAILABLE | LLM_SCHEMA_REPAIR_FAILED`, each value non-empty and ≤ 90 chars; (b) `FLAG_EXPLANATIONS` has exactly the keys `NUMERIC_MISMATCH | MEANING_DRIFT | UNSUPPORTED_CLAIM | DANGLING_PROVENANCE | LETTER_DUPLICATES_CV | INCONSISTENT_STATE | VERBATIM_FALLBACK | UNCERTAIN_TRANSLATION` (the union emitted by `src/lib/generation/factguard.ts` + `src/lib/generation/draft.ts` — hardcode the expected list as the guard), each value a single sentence naming edit/remove/confirm or double-check as appropriate; (c) `describeError("LLM_QUOTA", "x")` returns `{message: "x", action: <the LLM_QUOTA guidance>}` and `describeError("SOME_NEW_CODE", "x")` returns `{message: "x", action: null}` (unknown codes never invent guidance); (d) the module has zero imports (assertable by importing it into the client-safe test and by lint of `src/lib/client-messages.ts` containing no `import` statements)
- [x] T002 Implement `src/lib/client-messages.ts` — pure data + functions, zero imports: `LLM_ERROR_GUIDANCE` (action-pointer strings from contracts/error-messages.md), `FLAG_EXPLANATIONS` (one-sentence strings from contracts/fact-guard-ux.md), and `describeError(code, message)` splitting `statusError` on the first `": "` for code lookup. T001 goes green

**Checkpoint**: `npx vitest run tests/unit/client-messages.test.ts` green; module importable from client components.

---

## Phase 3: User Story 1 — Actionable Failure Messages (Priority: P1) 🎯 MVP

**Goal**: Every failure the smoke test hit renders cause + one concrete next action; provider detail is retained server-side; the overlap message stops pointing at a nonexistent "verify" action (spec FR-001–FR-004, SC-001; research R1/R5).

**Independent Test**: Trigger each failure class (dead model slug, zero-credit key, rate limit, date overlap, job PAGE_BUDGET_CONFLICT/EXPORT_GATE_FAILED) — the visible message names the failing step and a user-performable action, and the server log carries the provider status/body snippet.

### Tests for User Story 1 (write first, watch fail)

- [x] T003 [P] [US1] Unit suite `tests/unit/llm-errors.test.ts` asserting the SERVER message text per contracts/error-messages.md: `mapOpenRouterStatus(401/403).message` contains "Settings"; `(402)` contains "credit" and mentions top up or switching models; `(429)` names rate limiting and says retry; `mapOpenRouterStatus(500)` message keeps "Retry" and the work-preservation note; the `LLM_KEY_INVALID` message thrown by `src/lib/settings/keyStore.ts` (`requireKey`) mentions "Settings". Also assert via reading the source (regex on `src/lib/profile/repository.ts` content, same trick the codebase uses for fixture honesty) that neither overlap string contains "verify"
- [x] T004 [P] [US1] Extend `tests/integration/generations-api.test.ts`: seed two overlapping experience entries → `POST /api/generations` returns 409 `PROFILE_DATES_CONFLICT` whose `error.message` matches the new wording ("overlapping experience dates", "Profile editor", "Start/End dates") and does NOT contain "verify"; after PATCHing one entry's end date disjoint, the same POST returns 202

### Implementation for User Story 1

- [x] T005 [US1] Rewrite server messages + add provider-detail retention: `src/lib/llm/errors.ts` table per contracts/error-messages.md (Settings/credit-top-up/rate-limit-retry/unavailable-retry wording); `src/lib/llm/router.ts` — in the `postWithRetry` catch (~line 193) and the unmapped-status path, `console.warn(redact(...))` the HTTP status + a ≤200-char response-body snippet (never the key, full prompt, or full response) before mapping; keep `LLM_SCHEMA_REPAIR_FAILED`'s existing text + " Retry, or switch models in Settings."; T003 green
- [x] T006 [US1] Overlap strings in `src/lib/profile/repository.ts` — `detectDateOverlap` warning (~line 346) becomes "This role's dates overlap another role's — open the Profile editor and adjust the Start/End dates so each role has its own period."; the `PROFILE_DATES_CONFLICT` guard message becomes "The profile has overlapping experience dates, so a tailored CV cannot be generated. Open the Profile editor and adjust the flagged Start/End dates (each role needs its own period), then generate again."; no "verify" anywhere; T004 green
- [x] T007 [US1] Render `describeError` on the client surfaces: `src/app/upload/page.tsx` (`readError` returns the action line under the message), `src/app/jobs/page.tsx` (create-analysis failure), and `src/app/jobs/[id]/page.tsx` (job failure panel: mono code badge + message + action line, splitting `statusError` on the first `": "` — action pointers `PAGE_BUDGET_CONFLICT`/`EXPORT_GATE_FAILED`/default per contracts/error-messages.md). No server changes

**Checkpoint**: all five failure classes walked via API + UI show step + action; `npx vitest run` green.

---

## Phase 4: User Story 2 — Understandable Blocked Exports (Priority: P1)

**Goal**: The download area explains which gate is closed and why, each flag row carries a one-sentence explanation, and the state clears on resolution (spec FR-005–FR-007, SC-002; research R2).

**Independent Test**: On a document with pending blockers, the Downloads section alone tells the user which gate is closed, the blocker count, and links into the claim list; flag rows show explanations; resolving the last blocker enables downloads on the next refresh.

### Tests for User Story 2 (write first, watch fail)

- [x] T008 [US2] Extend the e2e fixture + spec: `tests/e2e/scripts/seed.ts` — the seeded validationReport gains one pending `NUMERIC_MISMATCH` blocker (on `exp.{firstExperience}.1`, matching the seeded content claim id) and `summary: {blockers: 1, warnings: 0}` with `layersRun.semantic: true`; `tests/e2e/08-generation-views.spec.ts` — assert (a) a "Claims need review first" block containing "1" and "Downloads unlock", with a link/scroll anchor into the claim review list; (b) the flag row shows the exact `NUMERIC_MISMATCH` explanation sentence from contracts/fact-guard-ux.md beside the code; (c) the existing "19 blockers"-style count assertions updated to the new seed

### Implementation for User Story 2

- [x] T009 [P] [US2] `src/components/generation/GenerationPanel.tsx` — derive `ExportGateState` from the polled payload exactly per data-model.md (`summary.blockers > 0`; `!layersRun.semantic`; `extractionCheck && !extractionCheck.passed`) and render one explanation block per closed gate in the Downloads section, in the order blockers → validation-incomplete → verification-failed, using the required text from contracts/fact-guard-ux.md; the blockers block's count is an anchor scrolling to the claim review list; keep `downloadDisabledReason` as tooltip fallback; no API calls added
- [x] T010 [P] [US2] `src/components/generation/ClaimReview.tsx` — under each flag row, render `FLAG_EXPLANATIONS[flag.code]` (fallback: nothing for unknown codes) beside the existing machine code; T008 green

**Checkpoint**: seeded blocked export renders per-gate text + flag explanations in the built app (`npx playwright test tests/e2e/08-generation-views.spec.ts`).

---

## Phase 5: User Story 3 — Visible Progress During Generation (Priority: P2)

**Goal**: A persistent indicator while a job runs, disabled-with-reason controls, and honest loading states (spec FR-008/FR-009, SC-003; research R3, contracts/ui-states.md).

**Independent Test**: A non-terminal job shows the indicator for its whole duration; disabled controls expose the reason; the document panel shows a loading line during its first poll.

### Tests for User Story 3 (write first, watch fail)

- [x] T011 [US3] Extend `tests/e2e/08-generation-views.spec.ts` (same file as T008 — run after it): seed one `queued` generation job for a second analysis; assert the progress indicator element (testid `gen-progress`) is visible beside the status badge, and the disabled Generate CV button carries `title="Generation in progress"`. Terminal-state regression: on the existing succeeded job, `gen-progress` is absent

### Implementation for User Story 3

- [x] T012 [US3] `src/components/generation/GenerationPanel.tsx` (after T009 — same file): render `data-testid="gen-progress"` with a CSS pulse (Tailwind `animate-pulse`) beside the status badge whenever `busy || ACTIVE_STATUSES.includes(job.status)`; add `title="Generation in progress"` to every control disabled by `busy || active` (selects, textarea, generate buttons) and to OmissionsList restore buttons via its props; render "Loading document…" until the first poll resolves (no downloads section / empty lists before then)
- [x] T013 [P] [US3] `src/app/jobs/[id]/page.tsx` — VERIFIED NO GAP (2026-10-25): the existing "Loading…" main states (lines ~155/413) suffice and the Playwright suite renders the page correctly in a real browser — the smoke test's blank panel was an in-app-browser hydration artifact, not an app defect; additionally added the contracts/ui-states.md "Loading document…" first-poll line to GenerationPanel. Original task: keep the existing "Loading…" main state (lines ~155/413) and verify the GenerationPanel mounts only after the analysis fetch settles (no finished-looking empty panel); adjust only if the smoke-observed blank-panel repro shows a real gap — the e2e evidence says the app is correct; record the conclusion in the task flip comment

**Checkpoint**: `npx playwright test tests/e2e/08-generation-views.spec.ts` green including progress assertions.

---

## Phase 6: User Story 4 — Clean Dual-Template Exports (Priority: P2)

**Goal**: The FR/EN/DE × ATS/designed download matrix is proven by tests and any exposed gap closed (spec FR-010/FR-011, SC-004; research R4).

**Independent Test**: All six matrix cells generate, verify, and download with the right template markers and intact accented text.

### Tests for User Story 4 (verification suite — green-on-arrival is the expected outcome; the task is to confirm and close gaps)

- [x] T014 [US4] Extend `tests/integration/generations-api.test.ts` (after T004 — same file): a `designed` × {`en`, `fr`, `de`} and `ats` × {`en`, `fr`, `de`} download matrix using the existing echo-LLM mock + supported verdicts: per cell — job succeeds; the pdf artifact row is `gate: "verified"`; extracted PDF text contains the language's headings (e.g. de: "Kurzprofil"/"Berufserfahrung"; fr: "Résumé professionnel") and survives accents (assert `é` and `ü` present in the fr and de cells respectively via the accented fixture content); the DOCX bytes carry the template markers (ats: no `<w:tbl>`; designed: `<w:gridCol w:w="3663"/>` + `w:fill="E8F0F8"`) — reuse the python3-zipfile read helper from `tests/unit/generation-designed.test.ts`
- [x] T015 [US4] NO GAP FOUND (2026-10-25): the 6-cell matrix passed once the fixture was corrected (added a missing education entry so the Education section renders; fixed the mock import) — no renderer changes were needed. Original task: Close any gap T014 exposes in `src/lib/generation/render/designed.ts`, `src/lib/generation/render/designed-docx.ts`, or `src/lib/generation/render/docx.ts` (accent folding, sidebar pagination, marker emission). If the matrix passes unchanged, flip this task with a note saying "no gap found" — do not invent changes

**Checkpoint**: matrix green; `npx vitest run` fully green.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T016 [P] Update `README.md` (generation section: actionable errors, per-gate export explanations, progress indicator, dual-template export confirmation) and record the validation run in `specs/006-polish-reliability/quickstart.md` §Recorded run (date, suites, pass counts, deviations incl. the T015 outcome)
- [x] T017 Final gate: `npm run lint` 0 errors, `npx tsc --noEmit` clean, `npx vitest run` all green (no regression in the pre-existing 303), `npm run test:e2e` green (progress + blocked-export specs included); walk quickstart.md manual scenarios 1–7 mentally against the implementation and note any scenario that cannot be exercised locally (e.g. no zero-credit key available)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: T001 → T002. BLOCKS US1 (T007 consumes `describeError`) and US2 (T009/T010 consume `FLAG_EXPLANATIONS`)
- **US1 (Phase 3)**: T003 ∥ T004 (different test files) → T005, T006 (different source files, parallelizable) → T007 (consumes T002's helper + verifies T005/T006 end-to-end)
- **US2 (Phase 4)**: after Phase 2; T008 (seed + spec, red) → T009 ∥ T010 (different components)
- **US3 (Phase 5)**: after Phase 2 only; T011 (e2e, after T008 — same spec file) → T012 (after T009 — same component file) ∥ T013
- **US4 (Phase 6)**: independent of US1–US3; T014 (after T004 — same integration file) → T015 (conditional)
- **Polish (Phase 7)**: after all stories

### Shared-file caution (sequential edits within the same file)

- `tests/integration/generations-api.test.ts`: T004 → T014
- `tests/e2e/08-generation-views.spec.ts` + `tests/e2e/scripts/seed.ts`: T008 → T011
- `src/components/generation/GenerationPanel.tsx`: T009 → T012
- Everything else marked [P] touches distinct files

### Parallel Opportunities

- Phase 2→3 entry: T003 ∥ T004 ∥ T008-seed-part (e2e seed edit is a different file from both vitest suites)
- T005 ∥ T006; T009 ∥ T010; T012 ∥ T013; T016 ∥ T017-partial (docs vs. gate run)

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 2 (client-messages + guard test) → Phase 3 (US1)
2. **STOP and VALIDATE**: every smoke-test failure class now self-explanatory — the highest-value slice
3. Then US2 (blocked-export UX) → US3 (progress) → US4 (export matrix) → Polish

### Incremental Delivery

Foundations → +US1 → +US2 → +US3 → +US4 → Polish — `npx vitest run` + `npm run test:e2e` stay green at every step.

---

## Notes

- Fail-closed Fact Guard semantics, deterministic pipeline behavior, and stored-artifact downloads are frozen — this feature changes message text, derived view state, and presentation only
- Strings are quoted verbatim from the contracts; if implementation needs to deviate, update the contract in the same task
- T014/T015 is a verification pair: green-on-arrival is success, not a failure of tests-first
- Do NOT git commit. After each task, flip `- [ ] T0nn` → `- [x] T0nn` in this file. Commit only when asked (Conventional Commits)
