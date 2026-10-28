---
description: "Task list for feature implementation"
---

# Tasks: Slice 3 — Evidence-Aware CV & Cover Letter Generation (Fact Guard + ATS Export)

**Input**: Design documents from `/specs/003-cv-generation/` — plan.md (structure, stack, sequence), spec.md (US1–US6 with priorities), research.md (R1–R12), data-model.md (entities + constraints), contracts/ (api.md, llm-tasks.md, generation-pipeline.md), quickstart.md (validation scenarios).

**Prerequisites**: Slices 1–2 implemented (profile + snapshots, matched JobAnalysis with stored MatchReport, `callLLM` registry with tiers + per-runId cost cap, error envelope, `unpdf`, `checkContainment`). Workspace rule: consult `node_modules/next/dist/docs/` before touching Next.js route APIs (AGENTS.md).

**Tests**: Included — plan.md Implementation Sequence step 10 and quickstart.md mandate the suites below; tests-first convention per `specs/002-jd-matching/tasks.md` (write tests, watch them fail, then implement).

**Organization**: Tasks grouped by user story; P1 stories (US1–US3) before P2 (US4–US6).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1…US6)
- Exact file paths in every description; data-model constraints quoted verbatim where they bind

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and error taxonomy for the whole slice

- [x] T001 Promote `pdf-lib` and `docx` from devDependencies to dependencies in `package.json` (research R1/R3 — no brand-new packages), run install, verify `npm run fixtures` still generates `tests/fixtures/*.pdf|docx`
- [x] T002 [P] Add generation error codes to `src/lib/api/errors.ts` per contracts/api.md: `ANALYSIS_NOT_MATCHED` (409), `GENERATION_INVALID_STATE` (409), `PAGE_BUDGET_CONFLICT` (409), `FACTGUARD_UNAVAILABLE` (409), `BLOCKERS_UNRESOLVED` (403), `EXPORT_GATE_FAILED` (409), `CLAIM_NOT_FOUND` (404), `OMISSION_NOT_FOUND` (404), `PROFILE_DATES_CONFLICT` (409), `INTERRUPTED` (500-ish failed-job state) — reuse existing `ERROR_CODES`/`STATUS_BY_CODE`/envelope, no new shape
- [x] T003 Add Prisma models to `prisma/schema.prisma` per data-model.md and create/apply a migration: `GenerationJob` (analysisId FK cascade, kind `"cv" | "cover_letter"`, settings Json, status `queued|running|succeeded|failed|cancelled`, statusError?, cancelRequested default false, attempt default 1, runId?, profileVersion Int, notice?, startedAt?/finishedAt?), `GeneratedDocument` (`@@unique([analysisId, kind])`, confirmations Json default "[]"), `GeneratedDocumentVersion` (`@@unique([documentId, version])`, producingJobId unique, content Json, validationReport Json, revision default 0, artifacts Json default "[]", extractionCheck Json?) — plus the reverse relations on `JobAnalysis`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schemas, persistence, async job runner, and job API — every user story builds on these

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create `src/lib/generation/schemas.ts` (zod, exported via `src/types` conventions): `GenerationSettings` (`outputLanguage: "fr" | "en"` default = analysis language, `pageBudget` 1..3 default 2, `tone: "professional" | "enthusiastic" | "formal"` default "professional", `notes` ≤ 2000 chars), `GeneratedCVContent`, `CoverLetterContent`, `Omission` (`{type, id, reason, restoredMustInclude?}`), `ValidationReport` (layersRun `{deterministic: true, semantic: boolean}`, flags with `code/claim/severity blocker|warning/affectedFieldIds?/sourceEvidence?/resolution pending|user_confirmed|edited|removed/confirmedAt?`, summary), `ArtifactMeta` (`format pdf|docx|txt`, gate `verified|best_effort|none`), `ClaimFingerprint`; claim-id builders emitting exactly `summary`, `exp.{experienceId}.{n}`, `proj.{projectId}.{n}`, `edu.{educationId}`, `cert.{certificationId}`, `letter.{n}`; fingerprint helper = `sha256(normalizeText(claimText) + "|" + sorted(evidenceIds).join(","))` (reuse `@/lib/text/normalize`, `EvidenceRef` from `@/lib/jobs/schemas`)
- [x] T005 Create `tests/unit/generation-schemas.test.ts` (failing first): settings bounds (pageBudget 1/3 pass, 0/4 fail; notes 2001 chars fail), claim-id roundtrips, fingerprint stability (same text+ids → same hash; changed text or evidence order-insensitive), content/report schema roundtrips
- [x] T006 Create `src/lib/generation/repository.ts`: `createGenerationJob` (guards: analysis `status = "matched"` with stored matchReport else `ANALYSIS_NOT_MATCHED`; unresolved profile date-overlap else `PROFILE_DATES_CONFLICT` — reuse the existing overlap check in `src/lib/profile/repository.ts`; pins `profileVersion = profile.version` at creation), status transitions enforcing terminal immutability (only `failed`/`cancelled` → `queued` via retry with `attempt + 1` and fresh `runId`), `setCancelRequested`, `listByAnalysis`, `getJob`, `markStaleRunningAsInterrupted` (`running` → `failed` with `statusError = "INTERRUPTED"`), `ensureDocument` (get-or-create by analysisId+kind), `appendVersion` (next version per document, producingJobId unique), `getCurrentVersion`, `updateVersionContent` (claim edits only; `revision + 1`), `recordConfirmation` + `findConfirmedFingerprints`, usage aggregation from `LlmUsageLog` by `runId`
- [x] T007 Create `tests/integration/generation-repository.test.ts` (failing first; test-DB + `clean()` pattern): lifecycle transitions, terminal immutability, retry semantics (attempt++/fresh runId), version chaining per `(analysisId, kind)`, fingerprint record/lookup, INTERRUPTED recovery, cascade delete with analysis
- [x] T008 Create `src/lib/generation/pipeline.ts` stage runner: kick-off-without-await entry (route calls it, does not await), status `queued → running → succeeded|failed|cancelled`, `cancelRequested` checked between stages and before each LLM call, per-stage error mapping to `statusError` (LLM taxonomy, cost cap), stages 1–7 per contracts/generation-pipeline.md initially as stubs behind a stage interface, stale-running recovery invoked on first list/read (research R4), one `runId` per attempt wired into `callLLM` calls
- [x] T009 Create API routes per contracts/api.md: `src/app/api/generations/route.ts` (POST create → 202 `{generationJobId, status, documentId, settings}`; GET `?analysisId` list), `src/app/api/generations/[id]/route.ts` (GET job + document summary incl. live `downloadable {pdf, docx, txt}` matrix + `summary {blockers, warnings}` + usage), `src/app/api/generations/[id]/cancel/route.ts` (POST, `GENERATION_INVALID_STATE` from terminal states), `src/app/api/generations/[id]/retry/route.ts` (POST from failed/cancelled → 202 `{attempt}`)
- [x] T010 Create `tests/integration/generations-api.test.ts` (failing first; mocked `callLLM`, direct handler invocation per existing pattern): POST guards (409 `ANALYSIS_NOT_MATCHED`, 409 `PROFILE_DATES_CONFLICT`, 400 invalid settings), 202 shape, polling GET shape, cancel from queued → cancelled, cancel of succeeded → 409, retry of failed → attempt 2, no version while stub pipeline

**Checkpoint**: Async job skeleton end-to-end — create → poll → cancel/retry with stub stages; all Phase-2 suites green.

---

## Phase 3: User Story 1 — Generate a Tailored, Evidence-Aware CV (Priority: P1) 🎯 MVP

**Goal**: From a matched analysis, an async job produces a CV draft whose every material claim carries provenance resolving to the pinned profile snapshot (spec US1; FR-001–FR-004, FR-006)

**Independent Test**: From a stored finalized analysis, run generation; verify async completion, every bullet's `sourceBulletIds` resolve to pinned-snapshot entries, omissions list present (possibly empty), result records `profileVersion`

### Tests for User Story 1 (write first, watch fail)

- [x] T011 [P] [US1] Create `tests/unit/generation-plan.test.ts`: ranking order under the contract formula (`0.45·relevance + 0.25·strength + 0.15·impact + 0.15·recency`, method weights exact 1.0 / approved_alias 0.9 / semantic 0.7, recency linear decay to 0 at 15 years), skills list built only from exact/approved-alias matches rendered in JD terminology ordered by importance then credit, must-include exemption from demotion, dangling MatchReport evidence refs skipped with `stale-analysis` notice (research R5)
- [x] T012 [P] [US1] Create `tests/unit/generation-draft.test.ts`: keyed merge keeps provenance from the plan (LLM output keyed by plan id), unkeyed LLM items dropped, plan keys missing from LLM output fall back to verbatim source text + `VERBATIM_FALLBACK` warning, summary carries `summaryProvenance`
- [x] T013 [US1] Extend `tests/integration/generations-api.test.ts`: full happy path with mocked `callLLM` (premium `generateTailoredCV` returns keyed items) → job succeeds, version 1 persisted with content + provenance, pinned `profileVersion` = profile.version at creation, `stale-analysis` notice when an evidenced entry was deleted, regeneration with changed settings appends version 2 (FR-018)

### Implementation for User Story 1

- [x] T014 [US1] Implement `src/lib/generation/plan.ts` stages 1–2 per contracts/generation-pipeline.md: pin snapshot (`ProfileSnapshot.data` at `profileVersion`), resolve MatchReport evidence refs against it (dangling → skip + notice), deterministic ranking with fixed tunable constants, whole-entry-before-bullet ordering, deterministic skills list, must-include set from restored omissions, payload-minimized plan items (id + source text + entry meta only)
- [x] T015 [P] [US1] Register premium task `src/lib/llm/tasks/generatetailoredcv.ts` per contracts/llm-tasks.md: keyed `items[]` output schema, `summary`, `uncertainTranslations?`, binding zero-invention + verbatim-proper-noun + copy-numbers-exactly prompt constraints; self-registering like existing tasks
- [x] T016 [US1] Implement `src/lib/generation/draft.ts`: call the task with the plan, merge by key attaching `sourceBulletIds`/`summaryProvenance` from the plan itself, drop unkeyed items, verbatim fallback + `VERBATIM_FALLBACK` warnings, build `GeneratedCVContent` with stable claim ids from T004
- [x] T017 [US1] Wire plan → draft → persist into `src/lib/generation/pipeline.ts` (guard/render stages still stubs that pass through; download stays disabled until US2/US3 — `layersRun.semantic = false` in the placeholder report keeps the gate closed)
- [x] T018 [US1] Build `src/components/generation/GenerationPanel.tsx` and wire into `src/app/jobs/[id]/page.tsx` for matched analyses: settings form (output language defaulting to the analysis's JD language, page budget 1–3 default 2, notes), Generate CV button → 202, polling job status, version summary with per-claim provenance drill-down (evidence refs → pinned profile entries)

**Checkpoint**: US1 independently testable — generate from a matched analysis, all claims trace to the pinned snapshot, T011–T013 green.

---

## Phase 4: User Story 2 — Fact Guard Gates Download (Priority: P1)

**Goal**: Two-layer claim-level validation with blockers that prevent every download until resolved or user-confirmed, plus claim edit/remove/confirm resolution (spec US2; FR-007–FR-010, FR-020)

**Independent Test**: A draft with a deliberately unsupported metric is flagged as a blocker and download is prevented; editing the claim clears the flag and unblocks download (at the gate level; file serving arrives with US3)

### Tests for User Story 2 (write first, watch fail)

- [x] T019 [P] [US2] Create `tests/unit/generation-factguard.test.ts`: one case per code in contracts/generation-pipeline.md — `DANGLING_PROVENANCE`, `UNSUPPORTED_CLAIM`, `NUMERIC_MISMATCH` (numbers/years/percentages/durations; identical rule for FR and EN text), `SKILL_UNVERIFIED`, `MEANING_DRIFT` (from verdicts, incl. missing-verdict → conservative drift), warnings never block, `layersRun.semantic=false` ⇒ gate closed even with zero flags (fail-closed, FR-010), fingerprint auto-confirm carried onto identical claims
- [x] T020 [US2] Extend `tests/integration/generations-api.test.ts`: claim PATCH (edit) re-validates + bumps revision + resolution `edited`; DELETE → `removed`; confirm → `user_confirmed` with attribution + fingerprint stored; download endpoint returns 403 `BLOCKERS_UNRESOLVED` with flag summary while a blocker is pending, unblocked after resolution; semantic-task failure → document still succeeds but `FACTGUARD_UNAVAILABLE` blocks download with deterministic flags still listed

### Implementation for User Story 2

- [x] T021 [P] [US2] Register economy task `src/lib/llm/tasks/factguard.ts` per contracts/llm-tasks.md: `{claims: [{claimId, text, evidenceText[]}]}` → `verdicts[]` (`supported|drifted|unsupported` + note), engine-side handling of unknown/missing claimIds (dropped / conservative drift)
- [x] T022 [US2] Implement `src/lib/generation/factguard.ts`: deterministic layer (zero AI — reference resolution against pinned snapshot, numeric/date/duration token identity via `normalizeText`, skills verification) + semantic layer wiring + `ValidationReport` assembly + confirmation-fingerprint application (auto `user_confirmed` on identical fingerprints, FR-009)
- [x] T023 [US2] Wire the Fact Guard stage into `pipeline.ts` after drafting (semantic failure does not fail the job — it sets `layersRun.semantic=false` and blocks download only, research R8); extend `GET /api/generations/[id]` document payload with the full `validationReport`
- [x] T024 [US2] Create claim-resolution routes per contracts/api.md: `PATCH`/`DELETE src/app/api/generations/[id]/document/claims/route.ts` (edit text → re-run both layers, rewrite `validationReport`, `revision + 1`; on semantic outage store the edit, refresh deterministic flags, return 409 `FACTGUARD_UNAVAILABLE`), `POST src/app/api/generations/[id]/document/claims/[claimId]/confirm/route.ts` (record + fingerprint), and `GET src/app/api/generations/[id]/document/route.ts` (full current version: content, flags, omissions, gate results)
- [x] T025 [US2] Create `src/app/api/generations/[id]/download/route.ts` skeleton: gate order per contracts/api.md — job succeeded with version (409 `GENERATION_INVALID_STATE`) → no pending blockers (403 `BLOCKERS_UNRESOLVED` + summary) → then 409 `EXPORT_GATE_FAILED`/`GENERATION_INVALID_STATE` while no artifact exists (file serving completed in US3/US6)
- [x] T026 [US2] Build `src/components/generation/ClaimReview.tsx`: flags grouped by severity with codes, affected claims, evidence, and resolution state; blocker banner ("download disabled until resolved"); edit/remove/confirm actions wired to T024 routes

**Checkpoint**: US1 + US2 both independently functional — Fact Guard blocks and unblocks the download gate; T019–T020 green.

---

## Phase 5: User Story 3 — Verified ATS Export (Priority: P1) 🎯 MVP complete

**Goal**: Single-column pdf-lib template with bilingual headings, page-budget fitting that records omissions, the two-level extraction gate, artifacts on disk, and gated downloads (spec US3; FR-011–FR-014)

**Independent Test**: Generate and export; the delivered PDF's extracted text contains all structural elements and every block reaches ≥95% word recovery; a deliberately corrupted render is blocked, retried, and never offered

### Tests for User Story 3 (write first, watch fail)

- [x] T027 [P] [US3] Create `tests/unit/generation-template.test.ts`: single-column output, heading map exact (EN: Professional Summary/Experience/Education/Skills/optional Projects/Certifications/Languages; FR: "Résumé professionnel"/"Expérience professionnelle"/"Formation"/"Compétences" + equivalents), dates as `YYYY-MM`/`present`, diacritics preserved (é è ç à pass through), WinAnsi-outside characters sanitized, optional sections never render empty, no text outside body content
- [x] T028 [P] [US3] Create `tests/unit/generation-verify.test.ts`: level 1 structural (name, each contact item, every rendered heading, each rendered experience entry's company/title/dates as normalized substrings), level 2 per-block ≥0.95 via `checkContainment`, accent-insensitive passes for legitimate French accents, a corrupted render (dropped page/garbled block) fails both levels
- [x] T029 [P] [US3] Create `tests/unit/generation-fit.test.ts`: over-budget content demotes lowest-scored demotable (whole entry before bullets) into `omissions {type, id, reason: "page_budget"}`, must-include items never demoted, nothing demotable + still over budget → `PAGE_BUDGET_CONFLICT`, no fixed quotas anywhere
- [x] T030 [US3] Extend `tests/integration/generations-api.test.ts`: succeeded job writes pdf artifact only after gate passes (`extractionCheck` stored, sha256/bytes in `artifacts`); gate failure → bounded re-render retries (max 3) → job fails `EXPORT_GATE_FAILED` with results stored, no artifact on disk; `download?format=pdf` streams the file with `Content-Disposition`; `format=docx` served ungated by extraction (best-effort) but still blocker-gated

### Implementation for User Story 3

- [x] T031 [P] [US3] Implement `src/lib/generation/render/template.ts`: shared single-column primitives (pdf-lib), fixed bilingual heading maps, `YYYY-MM`/`present` date formatting, WinAnsi sanitizer with diacritic-preserving behavior, page measurement API for the fit loop
- [x] T032 [US3] Implement `src/lib/generation/render/cv.ts`: the CV renderer — name/contact as body text atop page 1, section order Summary → Experience → Education → Skills → optional Projects/Certifications/Languages, no headers/footers/images
- [x] T033 [US3] Implement `src/lib/generation/fit.ts`: measure-and-demote loop per contracts/generation-pipeline.md (render → count pages → demote → re-render), omissions recorded, `PAGE_BUDGET_CONFLICT` when undemotable, must-include pre-check (conservative height estimate) failing early (research R9)
- [x] T034 [US3] Implement `src/lib/generation/verify.ts`: two-level gate on rendered bytes — `unpdf` extraction (`extractPdfPages`), structural normalized-substring checks, per-block `checkContainment` (identical rules FR/EN), full per-element/per-block `extractionCheck` result object
- [x] T035 [P] [US3] Implement `src/lib/generation/artifacts.ts` (disk storage under `UPLOADS_DIR/generations/{versionId}/` + sha256/bytes metadata into `artifacts` JSONB) and `src/lib/generation/render/docx.ts` (best-effort DOCX from the same content object — ungated by extraction, parent exception)
- [x] T036 [US3] Wire render → fit → gate → artifacts into `pipeline.ts` with bounded re-render retries (3 total attempts) and complete `download/route.ts`: `format=pdf` requires `extractionCheck.passed` (409 `EXPORT_GATE_FAILED` with results otherwise), `format=docx` best-effort
- [x] T037 [US3] Extend `src/components/generation/GenerationPanel.tsx` with the downloads section: PDF/DOCX buttons reflecting the live `downloadable` matrix, gate-failure state showing `extractionCheck` results, disabled-with-reason while blockers pending

**Checkpoint**: P1 MVP complete — upload → match → generate → Fact-Guard-clean → gate-verified PDF download; T027–T030 green.

---

## Phase 6: User Story 4 — Output Language Independent of Source (Priority: P2)

**Goal**: FR/EN output selection per generation, defaulting to the JD's detected language; full output-language narrative with verbatim proper nouns and identical numbers (spec US4; FR-015)

**Independent Test**: French profile + English JD → French output (and the reverse): fully output-language text, verbatim proper nouns, identical numbers/dates/metrics, Fact Guard validating against source-language evidence

### Tests for User Story 4 (write first, watch fail)

- [x] T038 [P] [US4] Create `tests/unit/generation-language.test.ts`: `outputLanguage` threading plan → draft prompt → renderer heading map; default = analysis language when unset; `VERBATIM_FALLBACK` and `UNCERTAIN_TRANSLATION` surface as warnings; numeric identity holds for FR and EN claim text under the same normalization
- [x] T039 [US4] Extend `tests/integration/generations-api.test.ts` with cross-language cases (mocked LLM returning translated content): FR profile → EN output and EN → FR — all narrative/headings in the output language, employer/institution/certification names verbatim, every number/date/duration identical to the profile, Fact Guard passes against source-language evidence

### Implementation for User Story 4

- [x] T040 [US4] Verify/complete language plumbing end-to-end: settings default resolution at `POST /api/generations` (`outputLanguage` defaults to `analysis.language`), explicit selection overrides regardless of profile/JD language, renderer headings and any language-conditional formatting driven solely by `settings.outputLanguage` (fix gaps found by T038/T039)
- [x] T041 [US4] Surface translation warnings in `src/components/generation/ClaimReview.tsx` (`UNCERTAIN_TRANSLATION` from `generateTailoredCV.uncertainTranslations`, `VERBATIM_FALLBACK` for skipped keys) with per-claim display in the UI

**Checkpoint**: Bilingual outputs verified in both directions; T038–T039 green.

---

## Phase 7: User Story 5 — Inspect and Reverse Omissions (Priority: P2)

**Goal**: Omissions list with type/id/reason, restore as must-include, explicit conflict instead of silent re-omission (spec US5; FR-005)

**Independent Test**: Tight page budget produces omissions; restore one item, regenerate, it appears; restore more than fits → explicit `PAGE_BUDGET_CONFLICT`, never silent re-omission

### Tests for User Story 5 (write first, watch fail)

- [x] T042 [US5] Extend `tests/integration/generations-api.test.ts`: restore route marks `restoredMustInclude: true` on the current version's omission; next regeneration includes the item (consumed — absent from new omissions); over-restoring beyond the budget → job fails `PAGE_BUDGET_CONFLICT` with actionable message; a fits-everything generation exposes a present-but-empty omissions list (no hidden truncation)

### Implementation for User Story 5

- [x] T043 [US5] Create `src/app/api/generations/[id]/document/omissions/[omissionId]/restore/route.ts` per contracts/api.md (404 `OMISSION_NOT_FOUND`; marks `restoredMustInclude` on the current version)
- [x] T044 [US5] Consume restored omissions in `src/lib/generation/plan.ts`: prior-version `restoredMustInclude` items enter the must-include set; the T033 pre-check fails `PAGE_BUDGET_CONFLICT` early when they cannot fit (SC-006); restored items that fit are consumed into content in the new version
- [x] T045 [US5] Build `src/components/generation/OmissionsList.tsx`: every omission with type, identifier, and reason; restore action; regenerate affordance; explicit conflict state surfaced from the failed job (`PAGE_BUDGET_CONFLICT` message with guidance)

**Checkpoint**: Omission loop closes — demote → inspect → restore → regenerate; T042 green.

---

## Phase 8: User Story 6 — Complementary Cover Letter (Priority: P2)

**Goal**: Letter as second job kind — tone setting, one page, no verbatim CV reuse, same Fact Guard, gated PDF + copyable plain text (spec US6; FR-016, FR-017)

**Independent Test**: Request a letter with a chosen tone after a finalized analysis: no verbatim CV bullets, traceable claims, gate-passing PDF, copyable plain text

### Tests for User Story 6 (write first, watch fail)

- [x] T046 [P] [US6] Create `tests/unit/generation-letter.test.ts`: letter plan builds angle-keyed paragraphs (motivation/fit/achievement) with evidence; `LETTER_DUPLICATES_CV` fires when a paragraph reaches ≥0.95 normalized containment vs any current-CV bullet/summary; 1-page fixed budget fitting (paragraphs as demotion unit); tone/`outputLanguage` honored in the task payload
- [x] T047 [US6] Extend `tests/integration/generations-api.test.ts`: letter job kind (`kind = "cover_letter"`, `pageBudget` fixed 1, tone default "professional"), full pipeline with mocked `generateCoverLetter`, claim ids `letter.{n}` with evidence refs, `download?format=txt` serves plain text (blocker-gated), complementarity blocker path (mocked letter returns a CV bullet verbatim → blocker → download blocked)

### Implementation for User Story 6

- [x] T048 [P] [US6] Register premium task `src/lib/llm/tasks/generatecoverletter.ts` per contracts/llm-tasks.md: angle-keyed paragraphs, `cvBulletTexts[]` input for repetition avoidance, ≤320 words, binding no-reuse + zero-invention constraints
- [x] T049 [US6] Extend `src/lib/generation/plan.ts` + `draft.ts` with the letter path: paragraph plan from profile evidence + MatchReport digest, keyed merge into `CoverLetterContent`, `kind` branch through `pipeline.ts` with fixed 1-page budget
- [x] T050 [US6] Implement `src/lib/generation/render/letter.ts` (single-column letter renderer) + the `LETTER_DUPLICATES_CV` deterministic check in `src/lib/generation/factguard.ts` + letter plain-text artifact in `artifacts.ts` + `format=txt` in `download/route.ts` (blocker-gated, ungated by extraction)
- [x] T051 [US6] Extend UI: letter generation in `src/components/generation/GenerationPanel.tsx` (tone selector), letter claim review reuse, "Copy as plain text" action

**Checkpoint**: Full application package — CV + letter, both gated; T046–T047 green.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Docs, final verification, spec-coverage sweep

- [x] T052 [P] Update `README.md` with the generation flow (generate → review claims → resolve blockers → verified download), the download-gate matrix, and the new API surface
- [x] T053 Run the full verification per quickstart.md: `npm run lint` clean, `npm test` full suite green (existing slice-1/2 suites unregressed), then walk quickstart.md manual scenarios 1–10 against `npm run dev` with fixture data
- [x] T054 Spec-coverage sweep: verify every FR-001–FR-020 and SC-001–SC-008 in spec.md maps to a passing test or quickstart scenario; record any gap as a follow-up note in specs/003-cv-generation/quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately (T001 before T003's fixture verification)
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **User Stories (Phases 3–8)**: All depend on Phase 2; execute in priority order US1 → US2 → US3 (P1), then US4/US5 (P2, parallelizable — different files), then US6 (needs US2 guard + US3 render)
- **Polish (Phase 9)**: After all desired stories

### User Story Dependencies

- **US1 (P1)**: After Phase 2 only
- **US2 (P1)**: After US1 (validates US1's drafts; download skeleton needs the document version)
- **US3 (P1)**: After US1 (renders its content); benefits from US2's gate but the extraction gate itself is independent — T025's blocker wiring already exists from US2, so keep US2 → US3 order
- **US4 (P2)**: After US1–US3 (exercises the whole path); parallelizable with US5
- **US5 (P2)**: After US3 (fit loop produces omissions); parallelizable with US4 (restores touch `plan.ts`/routes vs US4's language plumbing/UI — coordinate `plan.ts` edits or sequence if pairing)
- **US6 (P2)**: After US2 + US3 (Fact Guard + renderer); parallelizable with US4/US5 except shared `factguard.ts`/`pipeline.ts` edits with US5 — sequence those files

### Within Each User Story

- Tests first (must fail), then implementation in listed order (schemas/models → services → routes → UI)
- Story complete and independently testable before moving on

### Parallel Opportunities

- Phase 1: T002 parallel with T001
- Phase 2: T005/T011/T012/T019/T027/T028/T029 unit-test files are new files — can be drafted in parallel once T004 fixes the schemas/types they import
- Phase 3: T015 (new task file) parallel with T014; Phase 4: T021 parallel with T022's deterministic layer; Phase 5: T031/T035 parallel with T034
- After Phase 5: US4 ∥ US5 (with the `plan.ts` caveat), then US6

---

## Parallel Example: User Story 1

```bash
# Unit test files drafted together (new files, depend only on T004 schemas):
Task: "T011 generation-plan.test.ts"
Task: "T012 generation-draft.test.ts"

# Then implementation in parallel where files differ:
Task: "T014 src/lib/generation/plan.ts"
Task: "T015 src/lib/llm/tasks/generatetailoredcv.ts"   # new file, no shared deps
```

---

## Implementation Strategy

### MVP First (P1 stories only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational)
2. Complete Phase 3 (US1) → **validate independently** (draft + provenance)
3. Complete Phase 4 (US2) → **validate** (blockers gate download)
4. Complete Phase 5 (US3) → **STOP and VALIDATE the P1 MVP**: gate-verified PDF download end-to-end
5. This alone fulfills the product's core promise (evidence-backed, verified, ATS-safe CV)

### Incremental Delivery

1. Phases 1–2 → async job foundation
2. + US1 → tailored drafts with provenance (demo-able)
3. + US2 → trustworthy (blocked-until-clean exports)
4. + US3 → deliverable (verified PDF) — **MVP**
5. + US4 → bilingual; + US5 → reversible omissions; + US6 → full package
6. Phase 9 → docs + full-suite + coverage sweep

---

## Notes

- Tests-first is mandatory per slice convention: write the test task's suite, watch it fail, then implement
- Every task runs `npx vitest run <file>` (or full suite at checkpoints) before being marked `[x]`; integration tests need `docker compose up -d` + migrated test DB (global-setup handles it)
- Mocked `callLLM` in integration tests (existing pattern) — never hit OpenRouter in CI; live-key validation is manual (quickstart scenarios)
- `pdf-lib` needs plain `Uint8Array` (same caveat as unpdf, see `src/lib/parsing/pdf.ts`)
- Shared-file caution: `plan.ts`, `factguard.ts`, `pipeline.ts` are touched by multiple stories — within a story keep edits sequential; across parallel stories coordinate or sequence
- Commit after each task or logical group (Conventional Commits); never commit unless asked
