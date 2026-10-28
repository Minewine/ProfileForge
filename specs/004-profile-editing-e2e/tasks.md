---
description: "Task list for feature implementation"
---

# Tasks: Profile Editing End-to-End Test Suite (Playwright)

**Input**: Design documents from `/specs/004-profile-editing-e2e/` — plan.md (harness architecture), spec.md (US1–US6, FR-001–FR-014, SC-001–SC-006), research.md (R1–R8 incl. the four product-behavior discoveries), data-model.md (fixture set + isolation context + run state machine), contracts/e2e-suite.md (commands, config, selector, seeding contracts), quickstart.md.

**Prerequisites**: Slices 1–3 implemented and green (`npm test` = 24 files / 253 tests). Docker available for the `e2e-db` compose service. The editor page (`src/app/profile/page.tsx`), its routes, and the claim-validation endpoint exist and work — this feature adds tests plus a harness, not product behavior (the only `src/` touches are the two inert selector wirings allowed by FR-014 and research R5).

**Tests**: The deliverable itself is a test suite — each user-story phase's task writes the corresponding Playwright spec; no separate test-first tasks apply. The suite must itself be verified green (each checkpoint = its spec passing against the harness).

**Organization**: Phases follow the plan's Implementation Sequence; story phases in priority order (P1: US1–US3, P2: US4–US6).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1…US6)
- Exact file paths in every description; binding constraints quoted from the design docs

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The runnable harness — isolation, config, scripts

- [x] T00- [ ] T001 Add the `e2e-db` service to `docker-compose.yml`: postgres:16-alpine, host port **5434**→5432, database/user/pass `profileforge` (same credentials pattern as `db`), its own named volume (`profileforge_e2e_pgdata`), `pg_isready` healthcheck — mirroring the existing `db` service; verify `docker compose up -d e2e-db` reaches healthy
- [x] T00- [ ] T002 [P] Add `@playwright/test` as a devDependency (install with npm ≥ 11 per README note) and wire npm scripts in `package.json`: `e2e:install` = `npx playwright install chromium`, `test:e2e` = `docker compose up -d e2e-db` → `node tests/e2e/scripts/reset-db.mjs` → `playwright test`; append `uploads-e2e/`, `test-results/`, `playwright-report/`, and `tests/e2e/.seed-state.json` to `.gitignore`
- [x] T00- [ ] T003 Create `playwright.config.ts` per contracts/e2e-suite.md: `testDir: "tests/e2e"`, single chromium project, `workers: 1`, `fullyParallel: false` (scenarios share seeded state; file order matters), `globalSetup: "tests/e2e/scripts/seed.mjs"`, `webServer` = `next build && next start` on **port 3100** with env `DATABASE_URL` → the e2e DB (5434) and `UPLOADS_DIR=./uploads-e2e`, `reuseExistingServer: !process.env.CI`, `outputDir: test-results`
- [x] T00- [ ] T004 Create `tests/e2e/scripts/reset-db.mjs`: resolve the e2e `DATABASE_URL` (default `postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e`) and **abort before any mutation unless the URL contains `profileforge_e2e`** (FR-001, exit non-zero with a loud message); wait for the container healthcheck; `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then `npx prisma migrate deploy` against that URL only (datasource url override per prisma.config.ts conventions); print the MAIN db's `Profile.version` + per-table counts before reset (the SC-004 baseline)
- [x] T00- [ ] T005 Create `tests/e2e/scripts/seed.mjs` (Playwright `globalSetup`): wait for the webServer readiness; seed `fixtures/profile.ts` content via the app's own routes (`PATCH /api/profile` for basics+language, `POST /api/profile/entries/[section]` per entry, asserting 201/200 and that the returned `version` increments); LAST, apply the inconsistent fixture with one direct `pg` UPDATE setting `review_flag = 'containment_failed'` on the designated seeded `user_entered` experience bullet (the suite's only DB write); write `tests/e2e/.seed-state.json` with `{profileVersionAfterSeed, entryIds, inconsistent, duplicateSkillName}` (data-model.md shape); any non-2xx during seeding fails setup loudly (fixture drift surfaces at seed time, never mid-scenario)

**Checkpoint**: `npm run test:e2e` boots the isolated stack (e2e-db → schema reset → app on :3100 → seeded) with zero specs and exits cleanly.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Fixtures, selectors, and page objects every scenario drives

**⚠️ CRITICAL**: No user story spec can be written before this phase is complete

- [x] T00- [ ] T006 Create `tests/e2e/fixtures/profile.ts` per data-model.md: typed `ProfileFixture` — EN primary content covering all six sections (≥2 experience entries with distinct non-overlapping date ranges and bullets, education, skills incl. one WITH a stated level and one WITHOUT (FR-008 anchor), languages, a project with bullets, certifications), one FR bilingual experience entry with é/è/ç text and French content, the duplicate-skill seed name, and the inconsistent-fixture descriptor; all dates `YYYY-MM`/`"present"`; deterministic constants only
- [x] T00- [ ] T007 Inert selector wiring in `src/app/profile/page.tsx` (+ `src/components/profile/BulletEditor.tsx` if the bullet textareas live there), additive only per research R5/FR-014: `htmlFor`/`id` on every per-entry field input (`entry-{section}-{index}-{field}` pattern matching the basics card's existing `basics-{field}` convention) and `data-testid` on the `+ Add` buttons, entry containers, bullet textareas, the save-status span, version-history rows, and the Validate-claims button — no logic, text, or behavior changes; `npm test` and `npm run lint` must stay green
- [x] T00- [ ] T008 Create `tests/e2e/support/env.ts` (`baseUrl` from the Playwright config port; shared isolation assertion helpers) and `tests/e2e/support/editor.ts` page objects per contracts/e2e-suite.md: section lookup by CardTitle text (`Experience`, `Education`, `Skills`, `Languages`, `Projects`, `Certifications`), `addEntry(section)`, per-entry field get/set by label, bullet add/edit/remove helpers, `waitForAutosave()` = `page.waitForResponse` on the `PATCH /api/profile/entries/...` request (**never fixed sleeps** — the debounce is 800 ms per field, research R6.4), `saveStatus()` reader, `versionRows()` reader, and API-backed readers for `GET /api/profile` and `GET /api/profile/versions`

**Checkpoint**: Harness + page objects verified against the seeded app (a scratch spec navigating `/profile` and reading one section passes).

---

## Phase 3: User Story 1 — Seed Sample Data and See the Profile (Priority: P1) 🎯 MVP

**Goal**: Deterministic key-less seed verified end-to-end: every section displays its entries with provenance, bilingual content intact (spec FR-002–FR-004)

**Independent Test**: `npx playwright test tests/e2e/seed-and-display.spec.ts` passes against a freshly reset environment — the seed is visibly loadable

- [x] T009 [P] [US1] Create `tests/e2e/seed-and-display.spec.ts`: every seeded entry visible in its correct section (experience company/title/dates/bullets, education, skills, languages, project bullets, certifications); each entry shows a provenance badge (`user-entered` for seeded content, never blank); the FR entry's accented text renders verbatim; `Loading…` resolves to populated cards; `GET /api/profile` cross-check confirms the rendered set matches stored state (`lowConfidenceCount` reflected in the review-flags badge)

**Checkpoint**: US1 independently demoable — seeded profile visibly loads.

---

## Phase 4: User Story 2 — Experience CRUD, Including Bullets and Roles (Priority: P1)

**Goal**: Full experience lifecycle through the editor with persistence after each operation (FR-005)

**Independent Test**: `npx playwright test tests/e2e/experience-crud.spec.ts` — add/edit/remove all verified, including reload-gone

- [x] T010 [P] [US2] Create `tests/e2e/experience-crud.spec.ts`: add an entry (company, title, `YYYY-MM` dates, location, skills-used comma list, two bullets) → visible with both bullets; edit the **role/title** → persisted (autosave wait + still present after `page.reload()`); edit one bullet's text, add a second-page bullet, remove one → bullet list exact after each op (assert on text/order, never bullet ids — research R6.3); delete the entry → gone from the UI and gone after reload; `GET /api/profile` confirms the final state

**Checkpoint**: The richest section's CRUD is provably working through the real UI.

---

## Phase 5: User Story 3 — CRUD Across Languages, Skills, Education, Projects, Certifications (Priority: P1)

**Goal**: The remaining CRUD matrix plus the editor's guided decisions (FR-006–FR-008)

**Independent Test**: `npx playwright test tests/e2e/sections-crud.spec.ts` — all five sections' add/edit/remove and both dialog branches pass

- [x] T011 [P] [US3] Create `tests/e2e/sections-crud.spec.ts`: add/edit/remove one entry in each of languages, skills, education, projects (with a bullet), certifications; **duplicate-skill dialog**: re-add the seeded `duplicateSkillName` → dialog (`role=dialog`, `aria-label="Duplicate skill"`) appears → `Keep existing` leaves one canonical entry; the alternate branch = close dialog → rename → save succeeds (research R6.2: the dialog's only action is Keep existing — assert the product as built); **overlap warning**: create/edit an experience with dates overlapping a seeded entry → the `POST`/`PATCH` response `warnings` array contains `code: "DATE_RANGE_OVERLAP"` (API-level assertion per research R6.1 — the UI never renders warnings; recorded product finding); **level-less skill**: add a skill with no level → after autosave + reload no level is displayed or stored (FR-008)

**Checkpoint**: The full section × operation matrix (SC-002) is covered.

---

## Phase 6: User Story 4 — Autosave Persists Across Reload (Priority: P2)

**Goal**: The save contract verified at network level, both directions (FR-009)

**Independent Test**: `npx playwright test tests/e2e/autosave-persistence.spec.ts` — positive and negative persistence cases pass

- [x] T012 [P] [US4] Create `tests/e2e/autosave-persistence.spec.ts`: edit a seeded entry's field → wait for the PATCH response (page object's `waitForAutosave`) → `page.reload()` → the edited value is displayed exactly; negative bound: change a field and **reload before the 800 ms debounce fires** → the prior stored value is shown (no half-saved state); basics path: edit `basics-headline` → PATCH `/api/profile` observed → reload ⇒ persisted

**Checkpoint**: Autosave regressions (SC-005's target) would fail this spec.

---

## Phase 7: User Story 5 — Version History Captures the Edits (Priority: P2)

**Goal**: Exact version accounting across a known mutation sequence (FR-010)

**Independent Test**: `npx playwright test tests/e2e/version-history.spec.ts` — N edits ⇒ version +N with causes, stable across reload

- [x] T013 [P] [US5] Create `tests/e2e/version-history.spec.ts`: record the starting version from `GET /api/profile/versions` (matches the badge in the header and `.seed-state.json`'s `profileVersionAfterSeed`); perform N=3 known persisted edits (one entry create, one field edit with autosave wait, one delete) → `currentVersion` advanced by exactly 3, the three newest history rows carry `cause: "edit"` in order, and the UI's version rows render the same sequence; reload → history identical (stored, not client-derived); optional spot-check: `Restore` an earlier version → content reverts and a `restore`-cause row appears

**Checkpoint**: The version-pinning contract's recording half is locked from the editor.

---

## Phase 8: User Story 6 — Provenance and Fact-Guard Honesty (Priority: P2)

**Goal**: No silent invention at the profile layer (FR-011) — runs LAST against the seed (the inconsistent fixture is applied last by design, data-model.md state machine)

**Independent Test**: `npx playwright test tests/e2e/provenance-claims.spec.ts` — provenance transitions hold; validation is honest both ways

- [x] T014 [P] [US6] Create `tests/e2e/provenance-claims.spec.ts`: an entry added via the editor shows the `user-entered` provenance badge and stays attributed after edits (never blank/imported); click `Validate claims` on the clean phase (before the inconsistent fixture's flag is relevant — order the assertions to run the clean check first or scope it to non-fixture claims) → "All claims are grounded in profile evidence." OR a summary with **0 blockers**; then assert the inconsistent fixture surfaces: the flags list shows the `INCONSISTENT_STATE` code badge with the affected claim text (severity warning, surfaced never hidden); API cross-check `POST /api/validation/claims` returns the same flag codes with `summary.warnings ≥ 1`

**Checkpoint**: SC-002 complete — every story phase green.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Optional coverage, one-time proofs, docs, and the final gate

- [x] T015 [P] Create `tests/e2e/upload-optional.spec.ts` — the FR-002 optional scenario, `test.skip(!process.env.OPENROUTER_API_KEY, ...)` gated: upload `tests/fixtures/cv-en.pdf` through `/upload`, parse, import; then upload `cv-fr.pdf` and exercise the replace-or-merge decision (user-entered entries preserved) — the bilingual upload edge case from the spec
- [x] T016 SC-005 one-time proof (document in `specs/004-profile-editing-e2e/quickstart.md` after doing it, then revert): temporarily break the editor's autosave (e.g., comment the `schedule()` call) → `npx playwright test tests/e2e/autosave-persistence.spec.ts` FAILS with an actionable message → restore the code → green again; record the observed failure output in the quickstart's success-criteria section
- [x] T017 SC-003/SC-004 proof: run `npm run test:e2e` three consecutive times with no manual cleanup — all green; verify the main DB is untouched (its `Profile.version` + table counts identical before/after — reset-db.mjs prints them); record results in the quickstart
- [x] T018 [P] Update `README.md` (Tests section): the e2e suite, `npm run e2e:install` one-time step, `npm run test:e2e`, the isolation guarantees (dedicated 5434 DB + `uploads-e2e`, abort guard), and the browser-binary prerequisite
- [x] T019 Final gate: `npm run test:e2e` full run green within SC-001's 5-minute budget (record the wall time); `npm test` (vitest) still 253/253 green; `npm run lint` clean; Playwright HTML report spot-check (`npx playwright show-report`) shows failures (if any were fixed along the way) are diagnosable — scenario + operation + assertion visible (SC-006)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 first (T004/T005 need the container); T002/T003 parallelizable after T001
- **Foundational (Phase 2)**: depends on Phase 1 (T005 seeds via T006's fixtures — write fixtures before first seed run); BLOCKS all story specs
- **User Stories (Phases 3–8)**: depend on Phase 2; **execution order matters at run time even though files are independent** — playwright.config's serial run order is seed-and-display → experience-crud → sections-crud → autosave → version-history → provenance-claims (the inconsistent fixture must not pollute US6's clean assertion; earlier specs' mutations are accounted for by US5's relative version counting)
- **Polish (Phase 9)**: after all stories (T016/T017 exercise the finished suite)

### User Story Dependencies

- **US1 (P1)**: after Phase 2 only
- **US2 (P2 execution order, P1 priority)**: after Phase 2; independent of US1's spec (relies only on the seed)
- **US3 (P1)**: after Phase 2; independent files
- **US4/US5/US6 (P2)**: after Phase 2; US5's scenarios run before US6's in file order (numeric prefixes keep Playwright's order stable — name files with the `NN-` prefixes if alphabetical ordering needs enforcement)

### Within Each User Story

- The spec file is the deliverable; each must pass standalone (`npx playwright test <file>`) AND in the full serial run
- Fixtures/page objects precede specs (Phase 2 gate)

### Parallel Opportunities

- Phase 1: T002 ∥ T003 after T001; Phase 2: T006 ∥ T007 (different files — T007 touches `src/app/profile/page.tsx`, T006 a new fixtures file); T008 after T007 (page objects target the new selectors)
- Phases 3–8: all six spec files are new files — writable in parallel once Phase 2 lands, then verified together in one full run
- Phase 9: T015 ∥ T018

---

## Parallel Example: Phase 2 + story specs

```bash
# After Phase 1, these three are independent files:
Task: "T006 tests/e2e/fixtures/profile.ts"
Task: "T007 inert selector wiring in src/app/profile/page.tsx"
# Then T008 (consumes T007's selectors), and after Phase 2's checkpoint, in parallel:
Task: "T009 seed-and-display.spec.ts"
Task: "T010 experience-crud.spec.ts"
Task: "T011 sections-crud.spec.ts"
```

---

## Implementation Strategy

### MVP First (P1 stories only)

1. Phase 1 + Phase 2 (harness + fixtures + selectors)
2. US1 (seed-and-display) → validate standalone — **the suite already catches routing/render/load regressions**
3. US2 + US3 (both CRUD matrices) → validate — **SC-002's matrix complete**
4. STOP here = the P1 MVP the user description demands ("full CRUD … plus load/display")

### Incremental Delivery

1. + US4 (autosave) → persistence contract locked
2. + US5 (versions) → pinning contract locked
3. + US6 (provenance/claims) → honesty contract locked — full suite
4. Phase 9 → optional upload coverage, one-time proofs (SC-003/004/005), docs, final gate

---

## Notes

- The runner is Playwright per spec assumption + research R1; browsers install via `npm run e2e:install` once
- Never commit `.seed-state.json`, `uploads-e2e/`, `test-results/`, `playwright-report/` (T002's .gitignore additions)
- The abort guard (T004) is the suite's most important safety property — a run pointed anywhere but `profileforge_e2e` must die before mutating (FR-001)
- Product-behavior discoveries the specs must respect (research R6): overlap warnings are API-only (assert there), the duplicate dialog has only `Keep existing` (assert as built), bullet ids change on every save (assert on text/order), autosave is 800 ms debounced per field and refetches the whole profile after each PATCH
- T007 is the only `src/` touch and must be provably inert — `npm test` + `npm run lint` green after it, no visual/behavior change
- Commit after each task or logical group (Conventional Commits); never commit unless asked
