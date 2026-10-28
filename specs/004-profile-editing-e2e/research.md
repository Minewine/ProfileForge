# Research — Profile Editing E2E Test Suite

Phase 0 decisions, following `specs/003-cv-generation/research.md`'s format. Inputs: the spec (FR-001–FR-014), the codebase exploration brief (editor page, repository, routes, isolation machinery), and `ProfileForge-Specification.md`.

---

## R1: Runner — Playwright Test

**Decision**: Playwright Test (`@playwright/test`, new devDependency) with a single Chromium project, serial execution, and Playwright's `webServer` lifecycle to start/stop the app.

**Rationale**: The verification targets are UI-level (editor displays, dialogs, autosave round-trips), the repo has no browser runner today (confirmed: no Playwright/Cypress config or dependency), and Playwright's auto-waiting + network interception map directly onto the two hardest assertions here (debounced autosave confirmed at network level; abandoned-edit negative case). Cypress would add its own idiom for the same job; the project's current runner (vitest) is node-env only and cannot drive the DOM.

**Alternatives considered**: Cypress (equally capable; Playwright wins on network interception ergonomics and config-less webServer); vitest + jsdom (not a real browser — defeats the purpose); API-only suite (spec explicitly wants editor-flow verification).

---

## R2: Isolation — dedicated e2e Postgres + uploads + scratch port

**Decision**: A second compose service `e2e-db` (postgres:16-alpine, host port 5434, database `profileforge_e2e`, own volume) plus `UPLOADS_DIR=./uploads-e2e` and app port 3100. `reset-db.mjs` enforces the abort guard (refuses any configured `DATABASE_URL` that does not contain `profileforge_e2e`), then `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + `npx prisma migrate deploy` against the e2e URL only. Main-DB untouched-ness (SC-004) is verifiable by comparing the main DB's `Profile.version` and per-table counts before/after a run (the reset script prints them; the polish phase asserts them).

**Rationale**: FR-001 demands physical isolation, and a second compose service is the lightest durable boundary (the existing compose file already proves the pattern). A separate schema in the same instance would work but makes the abort-guard semantics fuzzier; a distinct port + database name makes "am I pointing at the right place?" checkable in one string comparison.

**Alternatives considered**: Reuse `profileforge_test` (the vitest DB) — fails "don't pollute": e2e mutations would persist between vitest runs unless double-reset; Testcontainers (new dependency, no benefit over compose here); same instance different schema (weaker isolation semantics).

---

## R3: Seeding — through the app's own HTTP routes, plus one direct `pg` write

**Decision**: `seed.mjs` runs after the server is up (Playwright `globalSetup`) and creates the fixture profile via `POST /api/profile/entries/[section]` and `PATCH /api/profile` — the same routes the UI uses, so seeding doubles as route-level regression coverage and needs no key (the parse flow is bypassed entirely). The one fixture that cannot be created through routes — the deliberately inconsistent `user_entered` entry carrying a `reviewFlag` (the editor path nulls flags on create; `INCONSISTENT_STATE` requires it) — is written directly with `pg` (an existing dependency). `seed-state.json` records created ids/version for spec assertions. Provenance of seeded entries is therefore `user_entered` (visible as the `user-entered` badge); imported provenance is only reachable via the key-gated parse flow and is not seeded.

**Rationale**: Key-less determinism (FR-002) rules out upload→parse; HTTP seeding exercises real contracts instead of bypassing them; no `tsx`/`ts-node` exists in the repo, and `pg` is already installed, so the direct-write fixture needs no new tooling.

**Alternatives considered**: Repository-layer seeding via a vitest-run script (possible but runs outside the server process — fine for data, yet still needs HTTP for UI-relevant state anyway); tsx devDep for standalone scripts (new tooling for no gain); skipping the inconsistent fixture (would leave FR-011's negative case untested).

---

## R4: App-under-test — production build via webServer

**Decision**: `playwright.config.ts` `webServer`: `next build && next start -p 3100` with env overrides (`DATABASE_URL` → e2e DB, `UPLOADS_DIR` → ./uploads-e2e), `reuseExistingServer: !process.env.CI`. Build caching keeps rebuilds fast; SC-001's 5-minute budget absorbs the build.

**Rationale**: `next build && next start` is deterministic (no on-demand compilation races in tests) and the build has no DB access at build time (page shells are client components; routes read env per request), so one binary serves any env. `next dev` would iterate faster but introduces compile-on-first-hit latency into timing-sensitive autosave scenarios.

**Alternatives considered**: dev server (faster startup, less deterministic); separate e2e build config (unnecessary — env vars suffice).

---

## R5: Selector strategy — accessible labels + inert test-id additions

**Decision**: Prefer role/label-based selectors (`getByRole`, `getByLabel`). The basics card and dialogs already support this; the per-entry section fields do not (Labels without `htmlFor`/`id`), so the plan adds `htmlFor`/`id` wiring on those inputs and `data-testid` on key structural controls (add buttons, entry containers, status span, version rows). Both are additive, non-behavioral changes under FR-014's allowance for minimal test-support touches.

**Rationale**: Positional/text-ambiguous selectors would make the suite brittle exactly where it edits (entry fields share label text across entries of a section). Stable anchors are the difference between a suite that catches regressions and one that flakes.

**Alternatives considered**: Pure text/placeholder selectors (ambiguous with multiple entries); adding no product touches (forces fragile selectors — rejected as false economy).

---

## R6: Product-behavior discoveries the suite must respect (documented, not fixed here)

1. **Date-overlap warnings are API-only**: `PATCH/POST` responses carry `warnings: [{code: "DATE_RANGE_OVERLAP", message}]`, but the profile page never displays `warnings` (verified in the editor page). The suite asserts the warning at the API level (FR-007's "surfaced, not swallowed" holds at the contract layer) and records the UI-display gap as a finding for the product, out of scope to fix here.
2. **Duplicate-skill dialog has one outcome**: `MergeOrKeepDialog` opens on 409 `DUPLICATE_SKILL` and offers only `Keep existing` (close = same). The "merge" branch in the spec is exercised as the product actually behaves: keep-existing (one canonical entry), and the alternate path is close → rename → save (no duplicate).
3. **Bullet saves rewrite bullet ids**: bullets are deleted and recreated on save (repository `updateEntry`), so bullet-id-based assertions must re-read after each save; the suite asserts on text and order, not bullet ids.
4. **Autosave is 800 ms debounced per field and not optimistic**: the UI refetches the whole profile after each PATCH; the suite waits on the PATCH response (network interception), never on fixed sleeps (FR-009), and the abandoned-edit case asserts the pre-edit value after reload.

**Rationale**: The suite tests the product as built; each discovery is either assertable at the layer where the behavior exists or recorded as a product finding. Silently changing the product to make testing easier would violate FR-014.

---

## R7: Version-history and claim-validation assertions — API-backed

**Decision**: US5 and US6's numeric assertions read `GET /api/profile/versions` and `POST /api/validation/claims` (the same endpoints the UI uses), while UI assertions confirm the same data renders (version badge, history rows, validation summary). The inconsistent fixture must yield `INCONSISTENT_STATE` (warning, code + affected field visible); a clean seeded profile must yield zero blockers.

**Rationale**: The spec (FR-010/FR-011) wants exact counts and machine-readable codes — API reads are deterministic; UI text alone is not. Cross-checking both layers catches divergence between stored state and rendering.

**Alternatives considered**: UI-only (imprecise); DB-direct reads (bypasses the contract the product actually exposes).

---

## R8: Run orchestration — one npm script

**Decision**: `npm run test:e2e` = ensure `e2e-db` is up (`docker compose up -d e2e-db`) → `reset-db.mjs` → Playwright (webServer starts the app, `globalSetup` seeds, specs run, server stops). `npm run e2e:install` installs browsers. Teardown is implicit (webServer lifecycle); the e2e container is left running (cheap, reused next run).

**Rationale**: FR-012's single-command requirement; reusing the container across runs keeps consecutive-run time inside SC-001 while the schema reset preserves determinism (SC-003).

**Alternatives considered**: Full teardown each run (slower, no benefit); leaving reset to the developer (violates FR-012/FR-013).
