# Implementation Plan: Profile Editing End-to-End Test Suite

**Branch**: `004-profile-editing-e2e` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-profile-editing-e2e/spec.md`; parent behaviors from `specs/001-ats-cv-tailoring/spec.md` (US2, FR-003–FR-007); editor internals per the exploration brief (profile page, repository, routes).

**Slice scope**: A runnable browser-level (Playwright) E2E suite with deterministic, key-less seeding, full section × operation CRUD coverage, autosave/version/provenance/claim-validation assertions, and a self-contained isolated environment (dedicated Postgres + uploads + scratch port) that provably never touches the main database.

## Summary

The suite lives under `tests/e2e/` as Playwright tests driving the existing `/profile` editor UI in a real browser, supplemented by API-level assertions where they are more precise (version history, claim validation, warnings). A harness (`tests/e2e/scripts/`) owns isolation: it starts/ensures a dedicated `e2e-db` Postgres container on port 5434, resets its schema (`DROP SCHEMA public CASCADE` + `prisma migrate deploy`), guards against ever pointing at the main database (refuses any `DATABASE_URL` not containing the e2e database name), and seeds fixtures — primary content through the app's own HTTP routes (which also verifies them), the deliberately inconsistent claim-validation fixture via a direct `pg` write (the only way a `user_entered` entry can carry a `reviewFlag`). Playwright's `webServer` starts the production build (`next build && next start`) on a scratch port with env overrides. One new devDependency (`@playwright/test`) is added — no browser runner exists in the repo; no other package changes.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 20, Playwright Test as the runner (new devDependency `@playwright/test`; browsers via `npx playwright install chromium` — one browser is enough locally).

**Primary Dependencies**: Existing app stack untouched. New (test-only): `@playwright/test`. Reused: `pg` (already a dependency — used by the reset/seed scripts to talk to the e2e database directly), Prisma CLI (`prisma migrate deploy` against the e2e DB), docker compose for the e2e Postgres service.

**Storage**: A dedicated Postgres instance (`e2e-db` compose service, host port **5434**, database `profileforge_e2e`, own volume) — physically separate from the main `db` service on 5433. Uploads go to `./uploads-e2e` (gitignored).

**Testing**: Playwright Test, `tests/e2e/**/*.spec.ts`, single Chromium project, `fullyParallel: false` (the scenarios share one seeded profile per run by design; serial execution, files ordered).

**Target Platform**: local-first developer machine; headless Chromium; app under test = `next build && next start` on port 3100 with env overrides (`DATABASE_URL` → 5434, `UPLOADS_DIR` → ./uploads-e2e, `PORT` = 3100).

**Project Type**: Test-suite addition to the existing single Next.js app; zero product-behavior changes.

**Performance Goals**: full suite < 5 minutes including build, DB reset, server start (SC-001); individual scenarios each < 15 s.

**Constraints**: no OpenRouter key required (seeding bypasses parse); abort-on-main-DB guard before any mutation; deterministic consecutive runs (reset every run); failures must identify scenario + operation + assertion; the vitest suite must remain untouched and green.

**Scale/Scope**: ~6 spec files, ~20 scenarios covering the US1–US6 matrix; one fixture module; two harness scripts (reset-db, seed) + compose service + npm scripts.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` remains an unfilled template (verified 2026-10-24) — no ratified gates exist. Governing constraints: this feature's spec and the parent spec's editor requirements. Pre-Phase-0: nothing to violate. **Post-Phase-1 re-check: unchanged — no gates to violate; the plan stays within the spec's FR-014 "no product behavior changes" rule (the two inert product-code exceptions are documented in Project Structure and research R6).**

## Project Structure

### Documentation (this feature)

```text
specs/004-profile-editing-e2e/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1–R8
├── data-model.md        # Phase 1 — fixture set + isolation-context contract
├── quickstart.md        # Phase 1 — run/debug guide
├── contracts/
│   └── e2e-suite.md     # npm scripts, config surface, fixture & seeding contracts
└── tasks.md             # $speckit-tasks output (NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
docker-compose.yml               # + e2e-db service (postgres:16-alpine, port 5434, own volume)
package.json                     # + devDep @playwright/test; + scripts: test:e2e, e2e:install
playwright.config.ts             # webServer (build+start on 3100, e2e env), single project, serial
tests/e2e/
├── fixtures/
│   └── profile.ts               # EN + FR sample data, inconsistent-fixture definition (typed)
├── scripts/
│   ├── reset-db.mjs             # abort-guard + DROP SCHEMA + prisma migrate deploy (e2e DB only)
│   └── seed.mjs                 # HTTP seeding via the app's own routes + pg write for the
│                                #   inconsistent fixture; writes seed-state.json for assertions
├── support/
│   ├── editor.ts                # page-object helpers: section selectors, entry CRUD, autosave wait
│   └── env.ts                   # base URL, isolation assertions shared by specs
├── seed-and-display.spec.ts     # US1 (+ US4 autosave, US5 versions, US6 provenance/hooks)
├── experience-crud.spec.ts      # US2
├── sections-crud.spec.ts        # US3 (languages, skills incl. duplicate dialog, education,
│                                #   projects, certifications, overlap warning via API)
├── autosave-persistence.spec.ts # US4
├── version-history.spec.ts      # US5
└── provenance-claims.spec.ts    # US6
.gitignore                       # + uploads-e2e/, test-results/, playwright-report/
```

**Inert product-code additions (the only touches under `src/`)**, both non-behavioral and required for stable selectors (the editor's section-entry fields currently have `Label`s without `htmlFor`/`id`, so accessible lookup cannot target them):
1. `htmlFor`/`id` wiring on the existing per-entry field inputs and bullet textareas (matches the basics card's existing pattern).
2. `data-testid` attributes on key controls (add-buttons, entry containers, status span, version rows, dialog trigger) — additive attributes only.

**Structure Decision**: Tests and harness live in a self-contained `tests/e2e/` tree, mirroring the existing `tests/{unit,integration}` convention, with the compose service, npm scripts, and Playwright config at the repository root where the tooling expects them.

## Implementation Sequence (guidance for $speckit-tasks)

1. **Harness**: compose `e2e-db` service; `reset-db.mjs` with the abort-on-main-DB guard; `seed.mjs` (HTTP seeding + `pg` fixture write + `seed-state.json`); `playwright.config.ts` with the build+start `webServer` and env overrides; npm scripts; `.gitignore` additions.
2. **Fixtures + page objects**: `fixtures/profile.ts` (EN sections, FR entry, inconsistent fixture) and `support/editor.ts` (section/entry/bullet helpers, autosave wait via response interception of the PATCH, version reader via API).
3. **US1 seed-and-display** → 4. **US2 experience CRUD** → 5. **US3 sections CRUD** (incl. duplicate dialog both branches, overlap warnings at API level) → 6. **US4 autosave persistence + negative case** → 7. **US5 version history** → 8. **US6 provenance + claim validation** (clean report; inconsistent fixture flags) → 9. **Polish**: SC-005 injected-regression verification (one-time, documented), SC-003/SC-004 consecutive-run + main-DB-untouched checks, README/test-doc updates.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — no constitution gates exist (placeholder constitution). The single new dependency (`@playwright/test`) is justified by the absence of any browser runner and the spec's UI-level verification targets.
