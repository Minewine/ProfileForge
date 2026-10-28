# Tasks: ProfileForge Slice 1 — CV Ingestion & Structured Profile Foundation

**Input**: Design documents from `/specs/001-ats-cv-tailoring/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md)

**Slice scope**: This task list implements **Slice 1 only** (per plan.md): US3 (AI key + LLM router), US1 (CV upload → parse → import), US2 (profile editor). Spec stories US4–US6 (JD analysis, CV generation, cover letter) belong to later slices and are intentionally absent.

**Tests**: Included — plan.md R12 and the user's global conventions mandate tests (vitest). Write tests first; they must fail before implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: user story (US1/US2/US3); setup/foundational/polish tasks carry no label
- File paths are project-relative (single Next.js app per plan.md structure)

---

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Initialize Next.js (App Router) project with TypeScript strict mode at repo root; configure path alias `@/*` → `src/*`; add `.gitignore` entries for `uploads/`, `.appsecret`, `.next/`, `node_modules/`
- [x] T002 Install runtime dependencies: `prisma`, `@prisma/client`, `zod`, `zod-to-json-schema`, `unpdf`, `mammoth`, `franc`; dev deps: `vitest`, `@types/node`
- [x] T003 Initialize Tailwind CSS + shadcn/ui with base components (button, input, dialog, badge, select, tabs) in `src/components/ui/`
- [x] T004 [P] Create `docker-compose.yml` (PostgreSQL 15, db `profileforge`, port 5432) and `.env.example` with `DATABASE_URL`, `OPENROUTER_API_KEY`, `APP_SECRET`, `UPLOADS_DIR=./uploads`
- [x] T005 [P] Configure vitest: `vitest.config.ts` with path alias, `tests/{unit,integration,fixtures}/` structure, and a test-database setup script (migrations applied per run)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ No user story work begins until this phase is complete.**

- [x] T006 Author `prisma/schema.prisma` with ALL entities per data-model.md: SourceDocument (sizeBytes `1..10485760`, detectedLanguage `fr|en`, parseStatus `unparsed→parsing→parsed|failed`, parseResult JSONB), Profile (version int, language, basics JSONB), Experience (**skillsUsed string[]**), Bullet (provenance `imported|user_entered|user_confirmed`, containmentOk boolean?, confidence float 0..1?, three nullable owner FKs with exactly-one-owner rule), Education, Skill (aliases string[], unique name per profile), LanguageSkill, Project, Certification, ProfileSnapshot (append-only), AppSettings (encrypted key, modelEconomy/modelPremium, costCapUsd default 0.50), LlmUsageLog; generate initial migration
- [x] T007 [P] Create Prisma client singleton in `src/lib/db.ts`
- [x] T008 [P] Create zod domain schemas in `src/lib/validation/schemas.ts` — enforces verbatim: dates `^\d{4}-(0[1-9]|1[0-2])$` or literal `present`; provenance invariant `imported ⇒ sourceDocumentId + sourceLocator present`; entry-level `language: "fr"|"en"|null`; export inferred types in `src/types/`
- [x] T009 [P] Implement local file storage in `src/lib/files/storage.ts`: content-addressed (sha256) writes under `UPLOADS_DIR`, guards `≤10 MB` and MIME ∈ {application/pdf, DOCX}
- [x] T010 [P] Implement the error envelope + code union in `src/lib/api/errors.ts`: `{ error: { code, message, details? } }` with codes `FILE_TOO_LARGE, UNSUPPORTED_FORMAT, NO_TEXT_LAYER, CORRUPT_FILE, PARSE_FAILED, LLM_KEY_INVALID, LLM_QUOTA, LLM_RATE_LIMITED, LLM_UNAVAILABLE, LLM_SCHEMA_REPAIR_FAILED, COST_CAP_REACHED, VALIDATION_ERROR, NOT_FOUND, CONFIRMATION_REQUIRED, SOURCE_IN_USE, DUPLICATE_SKILL`
- [x] T011 Implement `src/lib/profile/repository.ts`: getProfile, updateProfileSection, entry CRUD for all six sections — every mutation is transactional (change + `version += 1` + ProfileSnapshot append with cause `import|edit|restore`); case/accent-insensitive duplicate skill names → `DUPLICATE_SKILL`; date-range conflicts produce `warnings: [{code: "DATE_RANGE_OVERLAP", message}]` (warned, not blocked)
- [x] T012 Write integration tests for the repository in `tests/integration/profile-repository.test.ts`: version bump + snapshot on every mutation, duplicate-skill rejection, provenance invariant enforcement (imported without source ref rejected)

**Checkpoint**: Foundation ready — user story work can begin.

---

## Phase 3: User Story 3 — Configure Your Own AI Provider Key and Model (Priority: P2)

**Goal**: User supplies/validates their OpenRouter key (env var or encrypted setting), configures two-tier models + cost cap; every AI call flows through one router with structured outputs, usage logging, and actionable errors.

**Independent Test**: quickstart.md scenarios 1 (key save), 6 (invalid key) — valid key confirmed + masked; bogus key → `valid: false`; a parse without key → `LLM_KEY_INVALID`.

*Runs before US1 because parseCV depends on this router.*

### Tests for User Story 3

- [x] T013 [P] [US3] Write failing tests in `tests/unit/llm-router.test.ts` (fetch mocked): schema-pass, schema-fail→repair-retry (max 2)→`LLM_SCHEMA_REPAIR_FAILED`, cap reached → `COST_CAP_REACHED`, error mapping 401/403→`LLM_KEY_INVALID`, 402→`LLM_QUOTA`, 429→`LLM_RATE_LIMITED`, 5xx→`LLM_UNAVAILABLE`; plus key-masking tests in `tests/unit/keystore.test.ts`

### Implementation for User Story 3

- [x] T014 [US3] Implement `src/lib/settings/crypto.ts` (AES-256-GCM, key from `APP_SECRET` or auto-generated `.appsecret`) and `src/lib/settings/keyStore.ts`: resolution order env → encrypted AppSettings, masked hint (`sk-or-…1234`), redaction helper applied at the logger boundary (key never logged/exported)
- [x] T015 [P] [US3] Implement `src/lib/llm/errors.ts` (taxonomy above) and `src/lib/llm/usage.ts`: persist LlmUsageLog (task, model, runId, tokens, `usage.cost`, duration) + per-run cost accumulation checked before each call against `costCapUsd` (default 0.50)
- [x] T016 [US3] Implement `callLLM` in `src/lib/llm/router.ts` per contracts/llm-router.md: task registry (`parseCV` live; others → `TASK_NOT_IMPLEMENTED`), tier→model from settings, `response_format: {type: "json_schema", strict: true}` + `provider: {require_parameters: true}` (schema via zod-to-json-schema), local zod validation + ≤2 repair retries, 120 s timeout + 1 retry, payload minimization (task text only — never file bytes, settings, or key material)
- [x] T017 [US3] Implement settings API per contracts/api.md: `GET/PUT /api/settings` (never returns full key; models validated for `structured_outputs` support via the models endpoint; `0 < costCapUsd ≤ 100`) and `POST /api/settings/validate-key` (backed by OpenRouter key-info endpoint)
- [x] T018 [P] [US3] Build `src/app/settings/page.tsx`: key entry (masked after save), model pickers (economy/premium), cost-cap field, per-run token/cost usage display

**Checkpoint**: Key configured and router proven with mocked tests — US1 can proceed.

---

## Phase 4: User Story 1 — Upload and Parse an Existing CV into a Structured Profile (Priority: P1) 🎯 MVP

**Goal**: French/English PDF/DOCX upload → per-page extraction → language detection → LLM parseCV with deterministic post-pass (date normalization, source-containment, low-confidence flags) → import into the profile with bullet-level provenance.

**Independent Test**: quickstart.md scenarios 1–5 and 11 — EN + FR PDFs and DOCX parse with provenance + `YYYY-MM` dates; scanned PDF → `NO_TEXT_LAYER`; oversized/wrong format rejected; >10-page CV demands `confirmPartial` before partial parse.

### Tests for User Story 1

- [x] T019 [P] [US1] Create fixtures in `tests/fixtures/`: `cv-en.pdf`, `cv-fr.pdf`, `cv-en.docx`, `cv-fr.docx`, `scanned.pdf` (image-only), `cv-long.pdf` (>10 pages); write failing unit tests in `tests/unit/dates.test.ts` (EN/FR table: "Jan 2023", "01/2023", "janv. 2023", "sept. 2021 – aujourd'hui", "depuis 2020" → `YYYY-MM`/`present`; ambiguous → null+flag), `tests/unit/language.test.ts`, `tests/unit/containment.test.ts` (an invented bullet fails ≥95% word-level containment)
- [x] T020 [P] [US1] Write failing integration tests in `tests/integration/cv-ingestion.test.ts`: upload guards (10 MB, MIME, `NO_TEXT_LAYER`), `requiresPartialParseConfirmation` flag, parse without `confirmPartial` → `422 CONFIRMATION_REQUIRED`, import `replace_parsed` preserves `user_entered`/`user_confirmed` entries, parse failure leaves document re-parseable

### Implementation for User Story 1

- [x] T021 [US1] Implement `src/lib/parsing/pdf.ts`: unpdf per-page extraction → `[{page, text}]` + pageCount; ~zero text ⇒ `NO_TEXT_LAYER`
- [x] T022 [P] [US1] Implement `src/lib/parsing/docx.ts`: mammoth paragraph extraction → `[{paragraphIndex, text}]` + paragraphCount
- [x] T023 [P] [US1] Implement `src/lib/parsing/language.ts`: franc detection gated to `fr|en` with confidence threshold; low-confidence result marked for user correction
- [x] T024 [P] [US1] Implement `src/lib/dates/normalize.ts` (deterministic, no LLM): EN/FR month names/abbreviations, numeric formats, ranges, "present/présent/aujourd'hui" → `YYYY-MM` | `present` | `null + low-confidence flag` (never guess)
- [x] T025 [US1] Implement `POST /api/cv/upload` in `src/app/api/cv/upload/route.ts`: guards, sha256 storage, SourceDocument row (`parseStatus: "unparsed"`), response incl. `requiresPartialParseConfirmation` (PDF >10 pages OR extracted text >60,000 chars)
- [x] T026 [US1] Implement `PATCH /api/cv/[id]` (language correction feeding the parse prompt) and `DELETE /api/cv/[id]` (`204` unreferenced; `409 SOURCE_IN_USE` + `affectedEntryIds` when imported entries reference it) in `src/app/api/cv/[id]/route.ts`
- [x] T027 [US1] Implement the parseCV task in `src/lib/llm/tasks/parsecv.ts` per contracts/parsecv-task.md: zero-invention prompt constraints verbatim, page/paragraph markers in input, detected-language parameter, zod ProfileDraft output schema with `*Raw` dates, economy tier
- [x] T028 [P] [US1] Implement `src/lib/validation/sourceContainment.ts`: normalized (case-, accent-, whitespace-, punctuation-insensitive) ≥95% word-level containment of every bullet/material field against extracted text; failures → `containmentOk: false` + low-confidence flag
- [x] T029 [US1] Implement `POST /api/cv/[id]/parse` in `src/app/api/cv/[id]/parse/route.ts`: `confirmPartial` gate, runs task + deterministic post-pass (dates, containment, confidence flags, `partial`/`omittedPages`), stores parseResult, state transitions `unparsed→parsing→parsed|failed`
- [x] T030 [US1] Implement `POST /api/profile/import` in `src/app/api/profile/import/route.ts`: modes `replace_parsed` (removes `imported` entries, **preserves user_entered/user_confirmed**) | `merge`; copies language to Profile; sets entry-level `language` from source document
- [x] T031 [US1] Build the upload wizard `src/app/upload/page.tsx`: file drop → upload → detected-language display/correction → parse progress (≤120 s) → partial-parse confirmation dialog when required → draft review with low-confidence/containment flags → import choice

**Checkpoint**: Upload → parse → import works end-to-end for FR and EN. MVP demonstrable.

---

## Phase 5: User Story 2 — Review, Correct, and Enrich the Profile (Priority: P2)

**Goal**: Full-CRUD editor over all six profile sections with debounced autosave, provenance badges, low-confidence highlighting, duplicate merge-or-keep, language correction, and version history/restore.

**Independent Test**: quickstart.md scenarios 7–8 — edits persist without a save button; version list shows bumps with causes; duplicate skill triggers merge-or-keep; language switch updates metadata only.

### Tests for User Story 2

- [x] T032 [P] [US2] Write failing integration tests in `tests/integration/profile-editor.test.ts`: entry CRUD across sections, PATCH idempotency (autosave), provenance transition `imported → user_confirmed` only with open flags (and it clears them), `DUPLICATE_SKILL` 409 with `existingId`, `DATE_RANGE_OVERLAP` warning, version restore

### Implementation for User Story 2

- [x] T033 [US2] Implement `GET /api/profile` (DTO + `lowConfidenceCount` + `hasDraftAwaitingImport`) and `PATCH /api/profile` (basics, language) in `src/app/api/profile/route.ts`
- [x] T034 [US2] Implement entries routes `src/app/api/profile/entries/[section]/route.ts` (POST) and `src/app/api/profile/entries/[section]/[id]/route.ts` (PATCH/DELETE) for all six sections: idempotent debounced-autosave PATCH, `warnings[]` in responses, provenance transitions, bullet children via parent payloads (server ids for new bullets), `409 DUPLICATE_SKILL`
- [x] T035 [US2] Implement version routes `src/app/api/profile/versions/route.ts` (GET list) and `src/app/api/profile/versions/[version]/restore/route.ts` (POST restore; bumps version, cause `restore`)
- [x] T036 [US2] Build the editor `src/app/profile/page.tsx` + `src/components/` (SectionEditor, BulletEditor, ProvenanceBadge, LowConfidenceHighlight, MergeOrKeepDialog): ~800 ms debounced autosave, add/edit/delete across sections, language selector, version history view
- [x] T037 [P] [US2] Build the dashboard `src/app/page.tsx`: profile status, review-flag count with links into the editor, upload entry point, draft-awaiting-import banner

**Checkpoint**: Profile review/enrichment fully usable on top of imported data.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T038 Implement `POST /api/validation/claims` in `src/app/api/validation/claims/route.ts` per contracts/api.md: dangling provenance refs = blockers; `containmentOk: false` = blockers until `user_confirmed`; missing provenance marker = warnings; flag shape includes `sourceEvidence: EvidenceRef[] | null`
- [x] T039 [P] Add the claims-report panel to `src/app/profile/page.tsx` (blocker/warning counts, per-flag resolution states)
- [x] T040 Run the full quickstart.md validation pass (scenarios 1–11) with a real OpenRouter key; fix any failures; ensure `npm test` green and ESLint clean; record results in the PR/commit description
- [x] T041 [P] Write root `README.md`: one-paragraph product summary, setup commands from quickstart.md, env-var table, pointer to specs/001-ats-cv-tailoring/ design docs

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Phase 1 — **blocks all stories**
- **US3 (Phase 3)**: depends on Phase 2 only. *Deliberately runs before US1*: parseCV (US1) calls the US3 router
- **US1 (Phase 4)**: depends on Phase 2 + US3 router tasks (T014–T016)
- **US2 (Phase 5)**: depends on Phase 2; meaningful data comes from US1 but the editor is testable on an empty profile — can proceed in parallel with US1 once T011 is done
- **Polish (Phase 6)**: depends on US1 + US2 (claims validation reads both)

### User Story Dependencies

- **US3 (P2)** → no story dependencies
- **US1 (P1)** → US3 (router + key)
- **US2 (P2)** → none hard; integrates with US1 output
- US4–US6 → later slices, not in this list

### Parallel Opportunities

- Phase 1: T004, T005 parallel; Phase 2: T007–T010 parallel after T006
- US1: T022, T023, T024, T028 parallel once T021's extraction shape exists; T019, T020 test tasks parallel
- US2: T037 parallel with T033–T036; different stories can be worked in parallel by different people once foundations exist

---

## Implementation Strategy

### MVP First (Phases 1–4)

1. Complete Setup + Foundational
2. Complete US3 (key + router) → validate with mocked tests and the settings screen
3. Complete US1 (upload → parse → import) → **STOP and VALIDATE** against quickstart scenarios 1–5, 11 — this is the demoable MVP (env-var key + import works without the editor)
4. Add US2 (editor) → validate scenarios 7–8
5. Finish Polish (claims validation, full pass, README)

---

## Notes

- [P] = different files, no dependencies on incomplete tasks
- Tests are written FIRST and must FAIL before implementation (per user conventions + plan R12)
- Never log, export, or echo the OpenRouter key; redaction helper is mandatory in T014
- Never silently truncate long CVs — the `confirmPartial` gate is a hard requirement
- Never accept an LLM-parsed bullet failing source containment without flagging it
- Commit after each task or logical group; stop at any checkpoint to validate independently
