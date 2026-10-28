# Feature Specification: ProfileForge — Profile Editing End-to-End Test Suite

**Feature Branch**: `004-profile-editing-e2e`

**Created**: 2026-10-24

**Status**: Draft

**Input**: User description: "Add an end-to-end test suite that verifies the full profile editing flow with sample data. Scope: Seed or upload a sample CV (include both French and English content if easy); Verify the profile loads and displays existing entries; Test full CRUD on the profile editor: Add / edit / remove an Experience entry (including bullets), Add / edit / remove a Role or title within experience, Add / edit / remove Languages, Add / edit / remove Skills, Education, Projects, Certifications; Confirm autosave works and changes persist after reload; Confirm version history captures the edits; Confirm Fact Guard / provenance rules are respected (no silent invention); Clean up or isolate test data so it doesn't pollute the main profile. Use the existing Profile schema and editor routes. Output should be a runnable test (Playwright, Cypress, or the project's current test runner) plus any required sample fixtures."

**Parent specification**: This suite exercises the profile-editor functionality of [specs/001-ats-cv-tailoring/spec.md](../001-ats-cv-tailoring/spec.md) (US2 and FR-003–FR-007: full CRUD with provenance tracking, autosave, user-stated skill levels, approved-only aliases) and the profile-level claim validation of `ProfileForge-Specification.md` §6 (`validateClaims` precursor behaviors). It consumes the existing Profile schema and editor routes — no product behavior changes are in scope; the deliverable is a runnable browser-level test suite plus fixtures and its isolation harness.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Seed Sample Data and See the Profile (Priority: P1)

A developer (or CI) starts the suite against a clean, isolated environment. The suite seeds the profile with sample CV data — English content by default, with French content covered as a bilingual case — deterministically, without requiring an AI key or network access. Once seeded, the profile page loads and displays every seeded entry across all sections: experience entries with company, title, dates and bullets; education; skills; languages; projects; certifications.

**Why this priority**: Seeding plus display verification is the entry condition for every other story — no CRUD test can run before the profile visibly loads its entries.

**Independent Test**: Run the suite's seed step alone and open the profile page: every seeded entry is visible in its correct section. This already catches broken routing, rendering, and data-loading regressions.

**Acceptance Scenarios**:

1. **Given** a clean isolated environment, **When** the suite seeds the sample profile, **Then** the profile page displays all seeded entries in their correct sections, with dates rendered consistently.
2. **Given** the seeded profile, **When** a seeded entry is inspected, **Then** its provenance is visible (seeded entries are attributable — e.g., user-entered or imported — never blank).
3. **Given** French-language sample content, **When** it is part of the seed (or the bilingual case runs), **Then** accented text and French dates display correctly and the profile's language metadata reflects the content.

---

### User Story 2 — Experience CRUD, Including Bullets and Roles (Priority: P1)

The suite drives the profile editor through the complete experience lifecycle: add a new experience entry (company, role/title, dates, location, bullets), edit the entry — including changing the role/title and editing/adding/removing individual bullets — and finally remove the entry. After each step the editor reflects the change, and the change is saved (not just local state).

**Why this priority**: Experience entries are the richest section (nested bullets, dates, title field) and the one downstream generation depends on most; it is the heart of the editing flow.

**Independent Test**: Seed once, then run the experience CRUD scenario standalone: the added entry appears, edits (title, bullet text) stick, bullet add/remove works, and removal leaves no orphaned UI or data.

**Acceptance Scenarios**:

1. **Given** the seeded profile, **When** the suite adds an experience entry with two bullets, **Then** the entry appears with company, title, dates, and both bullets.
2. **Given** that entry, **When** the role/title is edited, **Then** the new title is displayed and persisted.
3. **Given** that entry, **When** a bullet is edited, another added, and one removed, **Then** the bullet list matches exactly after each operation.
4. **Given** that entry, **When** it is removed, **Then** it disappears from the editor and a subsequent reload shows it gone.

---

### User Story 3 — CRUD Across Languages, Skills, Education, Projects, Certifications (Priority: P1)

The suite applies the same add / edit / remove lifecycle to every remaining section: a language (with user-stated level), a skill (with optional user-approved alias and level), an education entry, a project (with bullets), and a certification. Where the product defines special dialogs — duplicate-skill merge-or-keep, date-overlap warnings — the suite exercises them honestly.

**Why this priority**: Completes the CRUD matrix; these sections are simpler than experience but carry their own rules (skill levels are user-stated only; aliases are approved-only).

**Independent Test**: Each section's scenario runs standalone against the seed: add → verify, edit → verify, remove → verify.

**Acceptance Scenarios**:

1. **Given** the seeded profile, **When** the suite adds, edits, then removes one entry in each of the five sections, **Then** each operation is reflected in the editor exactly.
2. **Given** a skill identical to an existing one, **When** it is added, **Then** the merge-or-keep decision appears and both outcomes behave correctly (no silent duplicate).
3. **Given** a skill added without a level, **When** it is saved, **Then** no level is inferred or displayed — the level stays unset until a user states one.
4. **Given** overlapping employment dates are entered, **When** the edit saves, **Then** the conflict warning is surfaced (not swallowed).

---

### User Story 4 — Autosave Persists Across Reload (Priority: P2)

The suite edits an entry and — respecting the editor's debounced autosave — waits for the save to actually land (network-level confirmation, not a fixed sleep), then reloads the page and verifies the change survived. It also verifies the negative bound: an edit abandoned before the autosave debounce fires does not partially persist.

**Why this priority**: Autosave is the editor's core persistence contract (parent FR-005), but it is a property of the CRUD flows rather than a separate feature — a suite that verified CRUD without reload-persistence could pass against a broken-save build.

**Independent Test**: Edit one field, wait for the save, reload — the value is unchanged by the reload; the negative case (abandoned edit) leaves the stored value untouched.

**Acceptance Scenarios**:

1. **Given** an edited field, **When** the autosave request completes and the page reloads, **Then** the edited value is displayed exactly as saved.
2. **Given** an edit made and abandoned before the debounce elapses, **When** the page reloads, **Then** the previous stored value is shown (no half-saved state).

---

### User Story 5 — Version History Captures the Edits (Priority: P2)

The suite records the profile version before its mutation sequence, performs a series of edits across sections, and then verifies that the version history shows the corresponding progression — each mutation bumps the version, causes is recorded per edit, and the history is listable in order. Where restore exists, the suite may spot-check that restoring an earlier version yields the earlier content, but the required assertion is that history captures the edits.

**Why this priority**: Version pinning is what makes later MatchReports and generated documents trustworthy (parent FR-027); this story verifies the recording half of that contract from the editor.

**Independent Test**: Note the starting version, make three known edits, verify the version advanced by three with the edit cause and correct ordering in the history view/API.

**Acceptance Scenarios**:

1. **Given** a recorded starting version, **When** the suite performs N known persisted edits, **Then** the current version advances by N and the history lists them in order with the edit cause.
2. **Given** the version history, **When** the suite reloads and re-reads it, **Then** the history is identical (stored, not client-derived).

---

### User Story 6 — Provenance and Fact-Guard Honesty (Priority: P2)

The suite verifies the no-silent-invention rules at the profile level: entries created through the editor carry user-entered provenance; edits update provenance rather than erasing it; running the profile claim validation produces an honest report (well-formed seeded content yields no blockers; a deliberately introduced inconsistency — e.g., an unresolved low-confidence flag — surfaces as a visible flag, not silence). Nothing is added to the profile that the user did not enter: no auto-added skills from text, no inferred levels.

**Why this priority**: These invariants are the product's first principle expressed at the editor layer; the suite locks them in so later features cannot regress them silently.

**Independent Test**: Add a well-formed entry → validation reports no new blockers; introduce the known inconsistency fixture → the expected flag appears with its code and affected field.

**Acceptance Scenarios**:

1. **Given** an entry added through the editor, **When** its provenance is inspected, **Then** it is recorded as user-entered (attributable, with timestamp metadata available via the API).
2. **Given** that entry is later edited, **When** provenance is inspected, **Then** it reflects the user edit (user-entered/user-edited) — never reverted to imported or blank.
3. **Given** a well-formed seeded profile, **When** claim validation runs, **Then** it completes with an honest summary (no fabricated blockers).
4. **Given** the deliberately inconsistent fixture, **When** claim validation runs, **Then** the expected flag(s) appear with machine-readable codes — the failure is surfaced, never hidden.

---

### Edge Cases

- **Second CV upload (bilingual path)**: uploading a French sample after the English seed presents the replace-or-merge decision; user-entered entries are preserved in either outcome.
- **Duplicate skill add**: merge-or-keep dialog appears; both branches leave exactly one canonical entry.
- **Overlapping dates**: warning surfaced, entry still saved (warning, not block) per slice-1 behavior.
- **Autosave race**: reload issued before the debounce fires must show the prior stored value — the suite must not mask timing bugs with generous sleeps.
- **Empty sections**: a fresh isolated environment renders empty sections cleanly (no crash, no phantom entries) before seeding.
- **Accented and bilingual text**: é/è/ç and French date forms survive the editor round-trip unchanged.
- **Long values**: unusually long bullet text and many-bullet entries remain usable (editable, savable) in the editor.
- **Fixture drift**: fixtures are regenerable/committed; a missing or stale fixture fails the suite loudly at setup, not mid-scenario.
- **Isolation breach**: if the suite is misconfigured to point at the developer's main database, it must refuse to run rather than mutate the main profile.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The suite MUST run against a fully isolated environment — a dedicated test database and separate uploads directory — and MUST NOT read or write the developer's main profile database; a misconfigured run (main DB detected) MUST abort before any mutation.
- **FR-002**: The suite MUST seed sample profile data deterministically, without requiring an AI provider key or network access; the upload-and-parse flow MAY be covered as an optional scenario explicitly gated on key availability.
- **FR-003**: Sample data MUST include English content and — as a covered bilingual case — French content (accented text and French date forms), with both committed or deterministically regenerable as fixtures.
- **FR-004**: The suite MUST verify that the seeded profile loads and displays every entry in its correct section, with visible provenance.
- **FR-005**: The suite MUST exercise add / edit / remove for an experience entry, including editing the role/title and adding, editing, and removing individual bullets, verifying the result after each operation.
- **FR-006**: The suite MUST exercise add / edit / remove in each of: languages, skills, education, projects, and certifications.
- **FR-007**: The suite MUST exercise the editor's guided decisions where the product defines them: duplicate-skill merge-or-keep (both outcomes) and the overlapping-dates warning.
- **FR-008**: The suite MUST verify skill-level honesty: a skill saved without a level stays level-less (no inferred level), per parent FR-006.
- **FR-009**: The suite MUST verify autosave persistence by confirming the save at the network level (or an equivalent deterministic signal) and then reloading the page to assert the stored value; it MUST also verify that an edit abandoned before the debounce fires does not persist.
- **FR-010**: The suite MUST verify version history: N known persisted edits advance the profile version by N with the edit cause recorded, and the history survives reload.
- **FR-011**: The suite MUST verify provenance transitions (user-entered on create; still attributed after edit) and MUST run the existing profile claim validation, asserting an honest report for well-formed content and the expected machine-readable flags for the deliberately inconsistent fixture.
- **FR-012**: The suite MUST be runnable with a single command from the repository root, MUST require no manual steps, MUST exit non-zero on any failure, and MUST produce failure output actionable enough to identify the failing scenario and assertion.
- **FR-013**: The suite MUST reset its isolated environment between runs (and between test groups where scenario isolation demands it) so repeated runs are deterministic; consecutive runs without manual cleanup MUST both pass.
- **FR-014**: The suite MUST reuse the existing Profile schema, editor routes, and page contracts — no product behavior changes (a minimal env-gated test-seeding helper is acceptable if needed for FR-002, and MUST be inert outside tests).

### Key Entities

- **E2E Fixture Set**: the committed or regenerable sample data — the seeded profile content (sections, bilingual text, dates), the deliberately inconsistent fixture for claim-validation assertions, and (optionally) the sample CV files for the key-gated upload scenario.
- **Isolation Context**: everything that scopes a run away from real data — dedicated database, uploads directory, port/base URL, and the abort-on-main-DB guard.
- **Scenario Matrix**: the section × operation coverage grid (experience incl. bullets/title, languages, skills, education, projects, certifications × add/edit/remove, plus autosave, versions, provenance, guided dialogs) — the suite's definition of "full CRUD coverage".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The full suite runs to completion in under 5 minutes on a development machine, including environment startup.
- **SC-002**: The scenario matrix is covered 100% — every section × operation cell has at least one passing scenario.
- **SC-003**: Three consecutive runs, with no manual cleanup between them, all pass (deterministic reset works).
- **SC-004**: The developer's main profile is verifiably untouched after a full run (its version and entry counts are unchanged).
- **SC-005**: An intentionally broken build (e.g., autosave disabled or a route returning errors) fails the suite — verified once during development by injecting a regression and observing the corresponding scenario fail with an actionable message.
- **SC-006**: 100% of suite failures produce output identifying the failing scenario, the operation, and the assertion — no silent skips or catch-all passes.

## Assumptions

- **Runner default**: Playwright (browser-level, TypeScript, multi-browser-capable) is the assumed runner — the user description permits "Playwright, Cypress, or the project's current test runner", and the flows to verify ("displays", editor interactions, dialogs) are UI-level. API-level assertions may complement UI assertions where more precise (e.g., version history reads).
- **Deterministic seeding is the primary path**: seeding populates the profile through the application's own repository/data layer (or an env-gated test-only seeding hook), not through the LLM-dependent parse flow — so the suite needs no OpenRouter key. The upload-and-parse flow is an optional scenario that runs only when a key is explicitly provided.
- The app under test is the existing Next.js application started on a scratch port with environment variables pointing at the isolated database/uploads — no second app build or product fork.
- Existing slice-1 behaviors are the contract: debounced autosave, version bump per mutation with cause "edit", provenance transitions, merge-or-keep on duplicate skills, overlap warnings, user-stated levels only (referenced from `specs/001-ats-cv-tailoring/spec.md`).
- The suite lives in the repository (e.g., a dedicated directory plus npm script) and is separate from the vitest unit/integration suites, which continue to run unchanged.
- Browser binaries are a development-time dependency (Playwright's install step); CI usage is future work and out of scope here.
- French bilingual coverage targets editor round-trips and language metadata; the optional key-gated upload scenario may use the existing French CV fixture when available.
- Out of scope: performance/load testing, visual regression snapshots, mobile viewports, and coverage of generation/matching flows (those belong to their slices' suites).
