# Tasks: Fix Profile Editor CRUD

**Input**: Design documents from `/specs/007-fix-profile-editor-crud/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included — the spec's success criteria (SC-001…SC-007) explicitly require automated verification, and research.md D10 defines the test strategy. Test tasks are ordered before the implementation they gate (red → green) wherever practical.

**Organization**: Tasks are grouped by user story. The design deliberately keeps stories independent: all shared save-semantics work (strict partial patches, id-preserving bullet sync) is foundational, after which each story touches distinct files/behaviors.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1…US5 map to spec.md)
- Include exact file paths in descriptions

## Path Conventions

Single Next.js project at repo root: `src/` (app + components + lib), `prisma/`, `tests/` (unit + integration + e2e). See plan.md Project Structure.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish a verified green baseline so regressions are attributable to this feature.

- [X] T001 Verify the pre-change baseline: `npm run db:up && npm run db:migrate && npm test` and `npm run test:e2e` all pass on the unmodified tree; record any pre-existing failures (these are SC-006's regression baseline, not this feature's to fix)
- [X] T002 [P] Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and confirm the awaited-`params` convention in `src/app/api/profile/entries/[section]/route.ts` and `[id]/route.ts` (workspace AGENTS.md mandate; no code change expected)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The strict-patch save semantics that every user story's save path depends on. No user story work may begin until this phase is complete — today's defaulted-patch behavior (research.md R1) corrupts every story's flows.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 [P] Write failing unit test `tests/unit/patch-schemas.test.ts`: for each section's patch schema (from `src/lib/profile/sectionSchemas.ts`), assert — a key absent from the input is absent from the parsed output (no defaults fabricated); `null` parses for every `.nullish()` optional (e.g., `startDate: null`); an explicit `provenance` value passes through present; required fields (`company`, `title`, `institution`, `name`, `title`) parse as optional; `""` for a date field fails with `VALIDATION_ERROR`-class issue
- [X] T004 [P] Write failing integration tests in `tests/integration/profile-editor.test.ts`: (a) field-only PATCH `{company: "X"}` on an experience that has 2 bullets keeps both bullets, their `id`s, `order`, and `skillsUsed`; (b) PATCH on a `user_confirmed` entry returns 200 and does not change `provenance`; (c) PATCH on an `imported` entry keeps `provenance: "imported"`, `reviewFlag`, `confidence`, `sourceDocumentId`, `sourceLocator`; (d) `{"startDate": null}` clears, `{"startDate": ""}` returns 400; (e) one PATCH with bullets diff — update one bullet's text, add one, remove one — keeps the updated bullet's `id` stable and persists all three changes
- [X] T005 Implement defaults-free patch schemas in `src/lib/validation/schemas.ts` (required fields relaxed to optional, `.default()` → `.optional()`, provenance fields optional, no provenance invariants) and switch `PatchSchemas` to them in `src/lib/profile/sectionSchemas.ts`; `CreateSchemas` unchanged (research D1). Makes T003 pass
- [X] T006 Apply strict-patch semantics in `updateEntry`/`buildEntryUpdate` in `src/lib/profile/repository.ts`: copy only keys present in the parsed patch (never defaults); invoke `applyProvenanceTransition` only when `provenance` is explicitly present and differs; keep date-overlap warnings and duplicate-skill behavior unchanged (research D1/D6)
- [X] T007 Replace `rewriteBullets` with an id-preserving `syncBullets(tx, owner, ownerId, bullets)` in `src/lib/profile/repository.ts`, wired into `updateEntry` for experience/projects: incoming bullet with existing `id` → update `text`/`order` in place (provenance fields only when provided; `sourceDocumentId`/`sourceLocator`/`language` never touched unless provided); bullet without `id` → create with `text` (min 1, max 2000) and the entry's provenance unless provided; existing bullet `id` absent from the payload → delete; `insertEntry` create-with-bullets unchanged (research D2). Makes T004 pass

**Checkpoint**: `npm test` green including T003/T004; field edits are now non-destructive server-side. Verify with a quick manual check: edit one entry field in the UI, confirm its bullets survive.

---

## Phase 3: User Story 1 - Edit existing profile content and have it persist (Priority: P1) 🎯 MVP

**Goal**: Every field edit — basics, entry fields, bullet text — autosaves, persists across reload, and disturbs nothing else (spec US1, FR-001…FR-005, FR-020).

**Independent Test**: Load the seeded profile, change one field in each section plus one bullet, reload, verify all changes persisted and everything else is untouched.

### Implementation for User Story 1

- [X] T008 [US1] Fix value parsing in `parseInput` in `src/app/profile/page.tsx`: empty string → `null` for every optional scalar field (startDate, endDate, location, degree, field, grade, proficiency, category, level, link, issueDate); keep the comma-split behavior for `skillsUsed`/`aliases` (empty input → `[]`); required text fields send the raw string (research D5)
- [X] T009 [US1] Fix the basics lost-update race in `src/app/profile/page.tsx`: accumulate pending basics edits in a ref and flush the merged object (`{ basics: { …lastSent, …pending } }`) on the debounced timer so two quick edits to different basics fields both persist; server keeps wholesale replace (research D8)
- [X] T010 [US1] Extend `tests/e2e/04-autosave-persistence.spec.ts`: edit a field on an entry that has bullets and reload (bullets still present); reword a bullet and reload (new text persists); clear an optional date via UI and reload (field is empty, no error); make two rapid successive edits to different fields of one entry (both persisted)
- [X] T011 [P] [US1] Extend `tests/e2e/06-provenance-claims.spec.ts`: after confirming an entry via the UI, edit one of its fields through the UI — save succeeds (network 200, `save-status` shows the new version), `provenance` badge unchanged

**Checkpoint**: User Story 1 fully works through the UI. Run `npm run test:e2e` — 02/04/06 specs pass without API workarounds for edits.

---

## Phase 4: User Story 2 - Add new entries and bullets in every section (Priority: P1)

**Goal**: "+ Add" works in all six sections; "+ Bullet" creates a draft that persists once typed; duplicate-skill guard reachable via UI (spec US2, FR-006…FR-008).

**Independent Test**: In an empty-per-section profile, add one entry per section, fill required fields, add two typed bullets to experience, reload — all persisted; duplicate skill add shows the dialog.

### Implementation for User Story 2

- [X] T012 [P] [US2] Simplify the `addBullet` helper in `tests/e2e/support/editor.ts`: clicking "+ Bullet" no longer triggers a PATCH — wait only for the PATCH triggered by filling text; update the file-header comment that documents "bullet ids are rewritten on every bullet save" (no longer true after T007)
- [X] T013 [P] [US2] Rework `src/components/profile/BulletEditor.tsx` to hold local draft state: "+ Bullet" appends a draft (`{ text: "" }`) locally with **no network call**; drafts are excluded from the `onChange` payload until their text is non-empty; an abandoned empty draft is discarded; reconciliation from props (post-refetch) must not clobber unsaved drafts or in-progress typing (research D3/D9)
- [X] T014 [US2] Fix `addEntry` in `src/app/profile/page.tsx` to send a valid placeholder payload per section (research D4): experience `{company: "New role", title: "Title"}` (existing), education `{institution: "New education"}`, skills `{name: "New skill"}`, languages `{name: "New language"}`, projects `{name: "New project"}`, certifications `{title: "New certification"}`; keep the 409 duplicate-skill dialog path
- [X] T015 [US2] Rework `tests/e2e/03-sections-crud.spec.ts` to add entries through the "+ Add" button for all six sections (removing the API-created workarounds), including a section that starts empty, then edit the placeholder fields via UI and reload-verify; reach the duplicate-skill dialog through the UI (`+ Add` skills with an existing name)
- [X] T016 [US2] Rework `tests/e2e/02-experience-crud.spec.ts` to add a bullet through the UI (remove the API workaround at ~:47-53): click "+ Bullet", type text, verify it persists after reload, and the bullet count/order are correct

**Checkpoint**: User Stories 1 AND 2 both work through the UI. `npm run test:e2e` green with no API workarounds in 02/03.

---

## Phase 5: User Story 3 - Remove entries and bullets (Priority: P2)

**Goal**: Deleting entries (with bullet cascade) and removing individual bullets works from the UI and persists (spec US3, FR-009…FR-011).

**Independent Test**: For each section, delete one entry and one bullet via UI, reload, verify removals persisted and other content intact.

- [X] T017 [P] [US3] Add integration coverage in `tests/integration/profile-editor.test.ts`: DELETE an experience entry removes the entry **and** its bullets (no orphan rows), remaining entries untouched; DELETE in each of the six sections succeeds and bumps `version`
- [X] T018 [US3] Extend `tests/e2e/02-experience-crud.spec.ts` and `tests/e2e/03-sections-crud.spec.ts`: delete entries via the UI Delete button (confirm dialog) in multiple sections and reload-verify; remove a single bullet of three via the ✕ button and reload-verify only that one is gone; delete the last entry of a section and verify the empty state renders and "+ Add" still works

**Checkpoint**: Full CRUD (except feedback polish) works through the UI.

---

## Phase 6: User Story 4 - Clear feedback for every save outcome (Priority: P2)

**Goal**: Saving/Saved/Failed states, specific visible errors with item context, and non-blocking warnings on every fetch path — nothing silent (spec US4, FR-012…FR-016; contract `contracts/editor-ui.md`).

**Independent Test**: Trigger each failure mode (empty required name, invalid email, unreachable server, overlapping dates) and verify the corresponding surface appears with the right content.

### Implementation for User Story 4

- [X] T019 [US4] Implement the status/error/warning surfaces in `src/app/profile/page.tsx` per `contracts/editor-ui.md`: `save-status` renders `Saving…` / `Saved · v{N}` / `Failed`; new `save-error` element (`{Item label} — {server message}`, item label from section + entry title or `Profile basics`, multiple zod issues joined with `; `, network failure → `Failed — could not reach the server`); new `save-warning` element (one line per warning, `code: message`); both cleared on the next save
- [X] T020 [US4] Wire failure and warning handling into **all** fetch paths in `src/app/profile/page.tsx`: `patchProfile` (currently has no failure branch at all), `saveEntry` (prefix item label), `addEntry` (non-409 failures currently silently dropped), `deleteEntry` (currently silent on failure); display `warnings[]` from successful POST/PATCH responses (currently discarded — `saveEntry` reads only `.version`)
- [X] T021 [US4] Create `tests/e2e/09-save-feedback.spec.ts`: clear Basics name → `save-error` visible with a name-specific message and no silent revert (reload shows last saved value); invalid email → `save-error`; intercept a PATCH route and abort it → `Failed — could not reach the server`; give two experiences identical dates → `save-warning` shows `DATE_RANGE_OVERLAP` **and** the save still succeeds (`Saved · v{N+1}`)

**Checkpoint**: No save outcome is silent; all stories' failures surface through the same contract.

---

## Phase 7: User Story 5 - Edits remain fully usable by generation, Fact Guard, and export (Priority: P2)

**Goal**: Non-regression proof: after CRUD, generation, Fact Guard, template export, and version history all work against the edited profile (spec US5, FR-017…FR-019; SC-006).

**Independent Test**: Edit a field, add a bullet, delete an entry via UI, then run generation + Fact Guard + template export successfully against the edited content; restore a version and edit it.

- [X] T022 [P] [US5] Add integration coverage in `tests/integration/profile-repository.test.ts`: after a field-edit PATCH and a bullets-diff PATCH, the newest `ProfileSnapshot.data` validates against `PinnedSnapshotSchema` (`src/lib/generation/plan.ts`) with the edited content and stable bullet `id`s (SC-002's server-side guarantee)
- [X] T023 [US5] Add a downstream e2e scenario (extend `tests/e2e/08-generation-views.spec.ts` or create `tests/e2e/10-downstream-integrity.spec.ts`): make UI edits (edit an experience field, add a bullet, delete an entry), then run the existing generation flow and assert success with the edited content reflected; run the template export path (`src/lib/generation/render/cv.ts` entry point) for the edited profile and assert it renders; in `tests/e2e/05-version-history.spec.ts`, restore a version and then edit one of its entries through the UI (save + reload persist — FR-019)
- [X] T024 [US5] Run the full Vitest suite (`npm test`) including the untouched generation/factguard/matching unit tests and confirm zero regressions vs the T001 baseline (SC-006)

**Checkpoint**: All five user stories independently functional; downstream consumers verified against edited data.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup and final validation.

- [X] T025 [P] Update stale comments that document the old behavior: `tests/e2e/support/editor.ts` header (bullet-id churn note — done in T012 if not already), `src/components/profile/BulletEditor.tsx` ("empty bullet textarea appears only after the PATCH lands" — now local), and any `specs/004-profile-editing-e2e/research.md`-derived comments in code that contradict the new semantics
- [X] T026 Run the full validation from `specs/007-fix-profile-editor-crud/quickstart.md`: `npm run lint` clean, `npm test`, `npm run test:e2e`, and the manual walkthrough (US1–US5 steps); record results against SC-001…SC-007

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on T001 baseline; **blocks all user stories** (T003/T004 red → T005/T006/T007 green)
- **US1 (Phase 3)**: depends on Phase 2 (its e2e assertions are only satisfiable on strict-patch semantics)
- **US2 (Phase 4)**: depends on Phase 2 (bullet sync); independent of US1's UI tasks (different concerns in `page.tsx`, but both touch it — sequence US1 → US2 to avoid same-file conflicts)
- **US3 (Phase 5)**: depends on Phase 2 and T013 (bullet removal interacts with draft state); test-only otherwise
- **US4 (Phase 6)**: depends on Phases 3–5 (it wires feedback into the save paths those stories shaped); T021 needs T019/T020
- **US5 (Phase 7)**: depends on Phases 3–6 (downstream verification over finished CRUD)
- **Polish (Phase 8)**: depends on all user stories

### User Story Dependencies

- **US1**: Foundational → T008 → T009 → T010/T011 (parallelizable)
- **US2**: Foundational → T012 (parallel with T013/T014 start) → T013, T014 → T015, T016
- **US3**: Foundational + T013 → T017 (parallel) → T018
- **US4**: US1–US3 → T019 → T020 → T021
- **US5**: US1–US4 → T022 (parallel with T023 start) → T023 → T024

### Parallel Opportunities

- T002, T003, T004 (Phase 1–2 test/doc tasks) run in parallel
- T010 ∥ T011 (different e2e specs); T012 ∥ T013/T014; T015 ∥ T016; T017 independent of T018; T022 ∥ T023; T025 any time after its target files settle
- Same-file conflicts to avoid: T006/T007 both edit `src/lib/profile/repository.ts` (sequence); T008/T009/T014/T019/T020 all edit `src/app/profile/page.tsx` (story order is the tiebreaker — do not parallelize across stories)

---

## Parallel Example: User Story 2

```bash
# Helper + component + page changes are in different files:
Task: "T012 Simplify addBullet helper in tests/e2e/support/editor.ts"
Task: "T013 Rework BulletEditor draft state in src/components/profile/BulletEditor.tsx"
# then page-level payload change and the two spec reworks:
Task: "T014 addEntry placeholder payloads in src/app/profile/page.tsx"
Task: "T015 Rework tests/e2e/03-sections-crud.spec.ts"
Task: "T016 Rework tests/e2e/02-experience-crud.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (baseline) + Phase 2 (strict-patch semantics)
2. Complete Phase 3 (US1)
3. **STOP and VALIDATE**: edits persist across reload with bullets intact — this alone resolves the most-reported breakage ("existing fields cannot be changed")

### Incremental Delivery

1. Setup + Foundational → server-side saves are non-destructive
2. + US1 → editing works end to end (MVP)
3. + US2 → profiles can be grown from the editor (completes the P1 pair)
4. + US3 → full CRUD
5. + US4 → every outcome visible, trust restored
6. + US5 → downstream non-regression proven
7. Polish → lint, docs comments, quickstart validation

### Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to spec.md user story for traceability
- Do not commit unless the user asks (workspace convention overrides the usual per-task commit guidance)
- Stop at any checkpoint to validate the story independently
- Avoid: vague tasks, same-file conflicts (see Parallel Opportunities), cross-story dependencies that break independence

---

## Phase 9: Convergence

**Purpose**: Remaining work found by the post-implementation convergence audit (independent read-only review of the code against spec.md, plan.md, contracts/, and this task list). Ordered by severity; source refs trace each task to its origin.

- [X] T027 [US1] Fix the stale bullet-edit overwrite: rapid successive edits to two different bullets of one entry must both persist — accumulate pending bullet edits per entry before the debounced flush (the T009 pendingBasics pattern) in src/app/profile/page.tsx / src/components/profile/BulletEditor.tsx, and extend tests/e2e/04-autosave-persistence.spec.ts with a two-rapid-bullet-edits case per FR-020 / US1 edge 1 (partial, HIGH)
- [X] T028 Reject renaming a skill to a duplicate: add a skill-name uniqueness check (case/accent-insensitive, excluding the entry itself) to `updateEntry` in src/lib/profile/repository.ts for the skills section, and handle a 409 `DUPLICATE_SKILL` response in `saveEntry` in src/app/profile/page.tsx by opening the MergeOrKeepDialog, per contract-editor-ui:41 (contradicts, MEDIUM)
- [X] T029 Cancel pending autosave timers for a deleted entry in `deleteEntry` in src/app/profile/page.tsx (clear `timers.current` keys prefixed `${section}-${id}-`) so an in-flight save firing after DELETE cannot render a spurious `save-error`, per spec Edge case 6 (partial, MEDIUM)
- [X] T030 Bind a bullet draft to its persisted bullet id once the first save lands (instead of exact-text reconciliation) in src/components/profile/BulletEditor.tsx so continued typing after the 800 ms debounce updates the persisted bullet in place instead of losing focus or duplicating, per FR-007 / research D3 (partial, MEDIUM)
- [X] T031 Close the downstream e2e gap: extend tests/e2e/10-downstream-integrity.spec.ts to assert the seeded generation views still render after the suite's UI CRUD (visit /jobs/{seedState.generation.analysisId}; fresh LLM generation is key-gated in this harness — export-after-edit is covered at integration level by T022), per T023 / US5 / SC-006 (partial, MEDIUM)
- [X] T032 Render `Saved · v{N}` for basics saves: parse the version from the PATCH /api/profile response body in `patchProfile` in src/app/profile/page.tsx instead of the plain `Saved` string, per FR-015 / contract-editor-ui:13 (partial, MEDIUM)
- [X] T033 Provide a basics `links` editing surface (url list, ≤10) in src/app/profile/page.tsx, or record it as accepted pre-existing scope with a code comment, per FR-001 / data-model.md Key Entities (partial, LOW)
- [X] T034 Reconcile the delete-confirmation mismatch: add a browser `confirm()` before DELETE in src/app/profile/page.tsx, or amend contracts/editor-ui.md to document the current no-confirm behavior, per contract-editor-ui:42 (contradicts, LOW)
- [X] T035 Assert `save-status` shows the new version in the confirm-then-edit test in tests/e2e/06-provenance-claims.spec.ts, per T011 (partial, LOW)
- [X] T036 Strengthen the strict-patch integration tests in tests/integration/profile-editor.test.ts: assert the entry's `order` survives a field-only PATCH, and assert `confidence` + `sourceLocator` are preserved on the imported-entry edit, per T004(a)/(c) (partial, LOW)
- [X] T037 Strengthen the removal e2e: use three bullets (removing one leaves exactly two) in tests/e2e/02-experience-crud.spec.ts, and re-assert the empty state plus a working "+ Add" after the final delete in tests/e2e/03-sections-crud.spec.ts, per T018 (partial, LOW)
- [X] T038 Render one element per warning in the save-warning area of src/app/profile/page.tsx instead of joining with ` • `, per contract-editor-ui:15 (partial, LOW)
- [X] T039 Focus the newly added entry's first field after the post-add refetch in src/app/profile/page.tsx, per contract-editor-ui:40 (partial, LOW)
- [X] T040 Update the stale comment in tests/e2e/06-provenance-claims.spec.ts:17-19 that says "UI `+ Add` is experience-only today" — false since FR-006, per T025 (partial, LOW)

---

## Phase 10: Convergence

**Purpose**: The single remaining item from the follow-up convergence audit — all 14 Phase 9 findings (G1–G14) verified RESOLVED with file:line evidence, and the core guarantees re-verified without regression (defaults-free patch schemas, id-preserving bullet sync, version/snapshot mutations, unchanged DTO, no new dependencies).

- [X] T041 [US1] Honor the contract's reconcile-exempts-unsaved-edits clause for persisted bullet rows: in src/components/profile/BulletEditor.tsx, track the last-emitted text per row (or an in-flight signal from the page) and, when refetched props arrive, keep the local text for rows edited since their last save instead of adopting the props text — today mid-typing into a persisted bullet during the save→refetch window is visually reverted (self-healing, since the captured timer payload still saves the newer text), so only the draft case is exempt per contract-editor-ui:35 (partial, LOW)
