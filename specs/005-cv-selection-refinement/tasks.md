---
description: "Task list for feature implementation"
---

# Tasks: Explicit, Evidence-Backed CV Selection & Rewriting (feature 005)

**Input**: Design documents from `/specs/005-cv-selection-refinement/` — plan.md (four changes, structure, sequence), spec.md (US1–US4, FR-001–FR-010, SC-001–SC-007), research.md (R1–R7), data-model.md (content extension, SelectionRecord, settings), contracts/selection-rewriting.md (cut policy, title claims, summary synthesis, omission reasons), contracts/api-additions.md, quickstart.md.

**Prerequisites**: Slice 3 implemented and review-closed (256 vitest + 14 e2e green); the 004 E2E suite in place. Inherited binding constraints: deterministic-first pipeline, keyed rewriting (provenance never passes through the model), fail-closed Fact Guard, page-budget fitting, single template, error taxonomy. Workspace rule: consult `node_modules/next/dist/docs/` before touching Next.js APIs (AGENTS.md).

**Tests**: Included — tests-first per the established slice convention (write the suite, watch it fail, then implement). Every suite that asserts pipeline payloads must parse them against the REAL task input schemas (the 003 review's P0 lesson: mocked `callLLM` hides schema drift).

**Organization**: Setup → Foundational → US1 (selection view, P1) → US2 (rewriting incl. titles, P1) → US3 (summary synthesis, P1) → US4 (omissions completeness, P2) → Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1…US4)
- Exact file paths in every description; binding constants quoted from contracts/selection-rewriting.md

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Migration, schema extensions, repository passthroughs

- [x] T001 Add `selection Json?` to `GeneratedDocumentVersion` in `prisma/schema.prisma` and create/apply the migration (`npx prisma migrate dev --name document_selection`) — additive and nullable per data-model.md; verify dev DB migrates and `npm test` stays green
- [x] T002 Extend `src/lib/generation/schemas.ts`: claim-id builder `titleClaimId(experienceId)` → `expTitle.{id}` + `parseClaimId` branch (kind `"experienceTitle"`); `ExperienceContentSchema` gains optional `title: {claimId, text (min 1), sourceTitle (min 1)}`; `SelectionRecordSchema`/`SelectionBasisSchema` (`{included: [{entryId, kind, rank, score, basis: {evidenceRefs: EvidenceRef[], methodCredits: string[], recency}}], generatedAt}`); `summaryMaxWords` in `GenerationSettingsInputSchema` (optional, int 30..120) and `GenerationSettingsSchema` (default 60); `OmissionSchema.reason` becomes `z.enum(["page_budget", "selection", "unwritten"])`; extend `tests/unit/generation-schemas.test.ts` first (claim-id roundtrips, title shape, settings bounds 29/30/120/121, selection record parse, omission enum) — watch it fail, then implement
- [x] T003 Extend `src/lib/generation/repository.ts` passthroughs: `appendVersion`/`upsertJobVersion` accept and persist optional `selection`; `getVersionForJob`/`getLatestSuccessfulVersion`/`DocumentSummary`/`DocumentVersionView` carry it; extend `tests/integration/generation-repository.test.ts` first (selection persists, round-trips through both append paths, null for legacy rows)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Pipeline plumbing every story builds on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Plumb the selection record through `src/lib/generation/pipeline.ts`: `StageContext.selection` (built in the plan stage — may be null until US1 lands the real builder), persisted via the persist stage's `appendVersion`/`upsertJobVersion`; extend `src/app/api/generations/[id]/document/route.ts` to return `selection` (null-safe) per contracts/api-additions.md; extend `tests/integration/generations-api.test.ts` first (document payload carries `selection: null` on today's pipeline — the shape lands before the content does)

**Checkpoint**: Migration applied; schemas/repository/pipeline accept and serve the new shapes with all suites green.

---

## Phase 3: User Story 1 — See Which Content Was Selected and Why (Priority: P1) 🎯 MVP

**Goal**: Explicit per-section selection cut with a persisted, user-visible basis (spec FR-001/FR-002; SC-001/SC-002/SC-007)

**Independent Test**: Generate from a rich fixture profile (more experience entries than the cap of 4) → the document's `selection` lists exactly the included entries with rank/score/evidence basis, unselected entries appear as `reason: "selection"` omissions, and regeneration is byte-identical in selection

### Tests for User Story 1 (write first, watch fail)

- [x] T005 [P] [US1] Extend `tests/unit/generation-plan.test.ts`: selection cut — with 6 ranked experience entries only the top 4 enter the plan's drafted items (caps per contracts/selection-rewriting.md: experience 4 / projects 2 / education 3 / certifications 3 at budget 2; budget 1 → max(1, floor(cap/2)); budget 3 → cap + 1); unselected entries become `reason: "selection"` omissions; restored must-include items always drafted and do NOT consume a cap slot; determinism — identical inputs yield identical selection and identical `SelectionRecord` (SC-002); the record's basis carries evidenceRefs/methodCredits/recency/rank per included entry
- [x] T006 [P] [US1] Extend `tests/integration/generations-api.test.ts`: a generation on a rich fixture persists `selection` on the version and returns it from `GET .../document`; the omissions list distinguishes `selection` from `page_budget` reasons; regenerating appends a new version with its own record

### Implementation for User Story 1

- [x] T007 [US1] Implement the cut in `src/lib/generation/plan.ts`: per-section caps (constants exported from the plan module, documented values), applied after ranking with deterministic tie-breaking; seed selection omissions into the plan; build `SelectionRecord` (rank within section before the cut, score, evidence refs, method credits, recency) and expose it to the pipeline; wire `ctx.selection` → persist (T004's plumbing)
- [x] T008 [US1] Create `src/components/generation/SelectionView.tsx` and wire into `src/components/generation/GenerationPanel.tsx`: per included entry — rank within section, score, evidence-ref links (reusing the panel's evidence-by-id map), recency; "not recorded" state for pre-feature versions (`selection === null`); omissions list renders the `selection` reason label

**Checkpoint**: US1 independently testable — generate → selection view + complete omissions; T005/T006 green.

---

## Phase 4: User Story 2 — Bullets and Role Titles Rewritten (Priority: P1)

**Goal**: Title claims end-to-end on the keyed-rewrite machinery; Fact Guard scope extends to titles (spec FR-003/FR-004/FR-009; SC-003/SC-004)

**Independent Test**: Generate in EN and FR — each selected entry's title is a keyed rewrite (differs from verbatim where the rewrite serves the JD, output language, employer verbatim), carries `expTitle.{id}` provenance, passes the Fact Guard, and the PDF's gate checks the rendered title

### Tests for User Story 2 (write first, watch fail)

- [x] T009 [P] [US2] Extend `tests/unit/generation-draft.test.ts`: title plan items merge into `experience[].title` (`expTitle.{id}`, `sourceTitle` from the plan); skipped title key → verbatim snapshot title + `VERBATIM_FALLBACK` warning; unkeyed title items dropped; payload conformance — the built payload (with title items) parses against the REAL `GenerateTailoredCVInputSchema`
- [x] T010 [P] [US2] Extend `tests/unit/generation-factguard.test.ts`: title claims collected (`expTitle.{id}`, evidence = entry ref); `NUMERIC_MISMATCH` fires for an invented number in a title; semantic drift flags a title; DELETE of a title claim falls back to the verbatim snapshot title (never title-less); PATCH/confirm work on `expTitle.*`
- [x] T011 [P] [US2] Extend `tests/unit/generation-verify.test.ts`: the level-1 structural element `experience:{id}:title` checks the RENDERED title (content title when present, snapshot title otherwise); a rewritten title that renders passes, a dropped/garbled one fails
- [x] T012 [US2] Extend `tests/integration/generations-api.test.ts`: generation persists `experience[].title`; claim PATCH/DELETE/confirm on `expTitle.*` round-trip through the routes; FR output — title in French, employer verbatim (SC-004 mechanism)

### Implementation for User Story 2

- [x] T013 [US2] Title plan items in `src/lib/generation/plan.ts`: one title item per SELECTED experience entry (key `expTitle.{id}`, kind `"title"`, sourceText = snapshot title, provenance = entry id, score = entry score) — whole-entry demotion removes it with the entry
- [x] T014 [P] [US2] Extend `src/lib/llm/tasks/generatetailoredcv.ts`: `GenerateTailoredCVOutputSchema` items already keyed — extend the input plan-item `kind` union with `"title"`, add the title instruction to the prompt (output language, no invented seniority/credentials, verbatim employer), and extend `PLAN_ITEM_KINDS`; keep old fixtures valid (additive)
- [x] T015 [US2] Keyed merge for titles in `src/lib/generation/draft.ts`: set `experience[].title` from the plan's provenance; verbatim fallback + warning; build `GeneratedCVContent` with the optional title shape
- [x] T016 [US2] Fact Guard + claim ops for titles in `src/lib/generation/factguard.ts`: collect title claims (evidence = entry snapshot ref), deterministic + semantic layers unchanged; `removeClaim`/`setClaimText` handle `expTitle.*` (remove → verbatim fallback title; findClaimEvidence resolves)
- [x] T017 [US2] Renderers + gate: `src/lib/generation/render/cv.ts` and `render/docx.ts` draw `content.title.text` (fallback snapshot title — company stays from the snapshot); `src/lib/generation/verify.ts` level-1 title element compares the RENDERED title
- [x] T018 [US2] Wire the title path through `src/lib/generation/pipeline.ts` `buildStages()` (draft stage merges titles; no other stage changes)

**Checkpoint**: US1 + US2 green — selection view + rewritten, provenance-carrying titles in both languages.

---

## Phase 5: User Story 3 — Custom Summary Synthesis (Priority: P1)

**Goal**: Per-JD summary from must-have requirements + strongest evidence, with a user-facing length bound (spec FR-005/FR-006/FR-007; SC-005/SC-006)

**Independent Test**: Two different MatchReports against the same profile produce different `summaryRequirements` in the task payloads (mechanism) — and the summary respects `summaryMaxWords`, carries provenance, and is Fact-Guard-validated like any claim

### Tests for User Story 3 (write first, watch fail)

- [x] T019 [P] [US3] Extend `tests/unit/generation-plan.test.ts`: `summaryRequirements` built from the report's must-have requirement texts (top ≤5, order-stable); empty when the report has no must-haves; `tests/unit/generation-draft.test.ts`: payload difference — two reports with different must-haves produce different `summaryRequirements` payloads (SC-005 mechanism) and `summaryMaxWords` threads into the payload; payload parses against the REAL input schema
- [x] T020 [US3] Extend `tests/integration/generations-api.test.ts`: `settings.summaryMaxWords` accepted (bounds enforced 400 outside 30..120), frozen on the job, returned in the 202 body

### Implementation for User Story 3

- [x] T021 [US3] Summary synthesis in `src/lib/generation/plan.ts` (build `summaryRequirements`) + `src/lib/generation/draft.ts` (payload) + `src/lib/llm/tasks/generatetailoredcv.ts` (input schema `summaryRequirements: z.array(z.string()).max(5)`, `summaryMaxWords`; rewrite the summary prompt line per contracts/selection-rewriting.md: connect strongest evidence to the listed requirement areas, ≤ N words, no generic blurb, zero invention)
- [x] T022 [US3] Settings UI: `summaryMaxWords` control in `src/components/generation/GenerationPanel.tsx` (default 60, bounds 30..120, sent with generate) — `resolveGenerationSettings` in `src/lib/generation/schemas.ts` already defaults it (T002)

**Checkpoint**: P1 stories complete — selection view, rewritten titles, synthesized bounded summary.

---

## Phase 6: User Story 4 — Omissions Completeness (Priority: P2)

**Goal**: Every profile entry in the draft or in the omissions list, reasons distinguishable, restore interplay intact (spec FR-008; SC-007)

**Independent Test**: A fixture where several sections exceed their caps → every unselected entry listed with `selection`; restoring one makes it must-include in the next version; over-restoring beyond the budget → explicit `PAGE_BUDGET_CONFLICT`

### Tests for User Story 4 (write first, watch fail)

- [x] T023 [US4] Extend `tests/integration/generations-api.test.ts`: completeness — build a profile exceeding caps in experience AND education AND certifications → the union of content entries + omission ids covers every profile entry, with `selection` reasons on the unselected (SC-001); a fitting generation shows a present-but-empty list; restore a `selection` omission → next generation includes it (consumed); over-restore → `PAGE_BUDGET_CONFLICT` with guidance

### Implementation for User Story 4

- [x] T024 [US4] Close any gaps T023 exposes in `src/lib/generation/plan.ts` (cut + omissions seeding covers non-experience sections — education/certifications/projects must emit selection omissions too) and `src/lib/generation/fit.ts` (a must-include restored entry later demoted by fit carries `page_budget`, never `selection` — research R6)

**Checkpoint**: All four stories green; SC-001/SC-007 enforced.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: E2E coverage, docs, final verification

- [x] T025 [P] Extend the 004 E2E suite: `tests/e2e/01-seed-and-display.spec.ts` (selection view visible with rank + evidence links after generation; `summaryMaxWords` control present) and `tests/e2e/02-experience-crud.spec.ts` (a rewritten title renders in the PDF-backed flow; the omissions list shows `selection` reasons on the seeded profile) — run `npm run test:e2e` green
- [x] T026 [P] Update `README.md` (generation section: explicit selection cut + SelectionView, title rewriting, summary synthesis + length setting) and record the SC-005 live spot-check result in `specs/005-cv-selection-refinement/quickstart.md` after one real-key run (or note it as pending a key)
- [x] T027 Final gate: `npm run lint` clean, `npx tsc --noEmit` clean, `npx vitest run` all green (existing suites unregressed), `npm run test:e2e` green; SC-005's live half either executed or explicitly recorded as pending-a-key in the quickstart

---

---

## Phase 8: Designed Two-Column Template (user-directed addition)

**Purpose**: A selectable designed CV template reproducing the attached design
(`assets/ProfileForge-CV-Template.docx`): left column photo/contact/skills/languages,
right column summary/experience/education, A4, Calibri-styled, navy `1E3A5F` headings,
sidebar shaded `E8F0F8`. The single-column ATS template STAYS THE DEFAULT. All
multi-value lists (skills, languages, experience entries, bullets per entry,
education, projects, certifications) render DYNAMICALLY from the plan/content —
the template's fixed placeholder counts (5 skills / 2 languages / 3 entries with
4-3-2 bullets / 2 education) are a design sketch, NEVER a schema. Output language
extends to FR/EN/DE (de explicit-select; detection default stays fr-else-en).
Gate/Fact Guard/sourceBulletIds/omissions apply unchanged — the designed PDF must
pass the same extraction gate (text-layer identical, layout irrelevant).

- [x] T028 [P] Schemas & language: `OutputLanguageSchema` + `"de"` (SECTION_HEADINGS.de, LANGUAGE_NAMES de in generatetailoredcv/generatecoverletter/factguard tasks); `GenerationSettingsInputSchema`/`GenerationSettingsSchema` gain `templateId: z.enum(["ats","designed"])` (optional-with-resolved-default "ats" — legacy rows and literals stay valid); `resolveGenerationSettings` emits it (cv only); the snapshot languages schema gains optional `proficiency` (sidebar renders levels); extend `tests/unit/generation-schemas.test.ts` (de accepted, templateId default/rejection, legacy settings parse) and `tests/unit/generation-template.test.ts` (de heading map)
- [x] T029 Designed PDF renderer `src/lib/generation/render/designed.ts` + dispatch (`render/dispatch.ts` used by fit.ts and the pipeline's render/gate-retry paths): two-column pdf-lib layout (A4, 36pt margins, sidebar 183pt shaded E8F0F8, main 340pt), name + initials photo placeholder, contact block (location/phone/email/links), skills one line each, languages with proficiency, main column summary/experience(title rewritten, fallback snapshot)/education/projects/certifications gated by `activeSections`; standard fonts, WinAnsi sanitizers, deterministic bytes; new `tests/unit/generation-designed.test.ts` — dynamic counts (N entries × M bullets, K skills, J languages all present in extracted text), extraction gate passes on the designed render, determinism (byte-identical), `fitCVToBudget` respects the budget with the designed template
- [x] T030 [P] Designed DOCX renderer in `src/lib/generation/render/docx.ts` (dispatch on templateId): 2-column table (grid 3663/6803 twips), sidebar cell shaded E8F0F8, Calibri, navy 1E3A5F headings, gray meta, one paragraph per dynamic item (no fixed counts); extend tests — unzip the artifact, assert grid widths, shading, and per-item paragraphs
- [x] T031 Integration: `tests/integration/generations-api.test.ts` — POST with `settings.templateId: "designed"` + `outputLanguage: "de"` → succeeded job, frozen settings, gate-verified pdf artifact, omissions/selection unchanged; ATS default unchanged when templateId absent
- [x] T032 [P] UI: `src/components/generation/GenerationPanel.tsx` — Deutsch option in the output-language select + a Template select (ATS single-column default / Designed two-column), sent with generate

**Checkpoint**: both templates selectable end-to-end; every suite green; the gate
passes the designed PDF like the ATS one.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 first (T003's repository passthroughs need the column); T002 [P] parallel
- **Foundational (Phase 2)**: T004 after T001–T003 — BLOCKS all stories
- **User Stories (Phases 3–6)**: US1 first (the cut changes what US2's titles attach to and what US4 asserts); US2 after US1 (title items exist only for SELECTED entries); US3 after Phase 2 only (independent of the cut — could parallelize with US1 if staffed, but shares `plan.ts`/`draft.ts` with US1/US2 — sequence those files); US4 after US1+US2 (asserts the union behavior)
- **Polish (Phase 7)**: after all stories

### Within Each Story

- Tests first (must fail), then implementation in listed order; story complete before the next

### Parallel Opportunities

- Phase 1: T002 ∥ T003 (after T001)
- Phase 4: T009/T010/T011 (three different test files) drafted together; T014 (task file) ∥ T013
- Phase 7: T025 ∥ T026
- Shared-file caution: `plan.ts` (T007, T013, T021), `draft.ts` (T015, T021), `schemas.ts` (T002, T021's settings) — within a story keep edits sequential; across stories US1 → US2 → US3 ordering avoids conflicts by design

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 + Phase 2 (schemas, migration, plumbing)
2. US1 → **STOP and VALIDATE**: selection view + complete omissions — the inspectability core
3. Then US2 (titles) → US3 (summary) → US4 (completeness assertions)

### Incremental Delivery

1. Foundations → 2. +US1 → 3. +US2 → 4. +US3 → 5. +US4 → 6. Polish — each step keeps `npm test` + `npm run test:e2e` green

---

## Notes

- Tests-first everywhere; payload-conformance tests parse against REAL task schemas (003 review P0 lesson)
- Caps are documented constants (contracts/selection-rewriting.md): experience 4 / projects 2 / education 3 / certifications 3 at budget 2 — budget 1 → max(1, floor(cap/2)), budget 3 → cap + 1; determinism (SC-002) must survive every edit to the cut
- `OmissionSchema.reason` becomes an enum — check for any fixture using other reason strings before tightening (003 tests use `page_budget`/`unwritten` only)
- Title claims: DELETE → verbatim fallback (never title-less); the extraction gate compares the RENDERED title; company always comes from the snapshot
- The summary prompt rewrite replaces the hardcoded 60-word line with the `summaryMaxWords` setting
- Do NOT git commit. After each task, flip `- [ ] T0nn` → `- [x] T0nn` in this file. Commit after each task or logical group only when asked (Conventional Commits)
