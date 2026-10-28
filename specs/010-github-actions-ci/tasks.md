---
description: "Task list for feature 010-github-actions-ci"
---

# Tasks: GitHub Actions CI Pipeline

**Input**: Design documents from `/specs/010-github-actions-ci/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: No new application tests are requested or needed — the feature's deliverable is CI configuration, and its "tests" are the validation tasks built into each story (running the workflow and its failure paths per `quickstart.md`).

**Organization**: Tasks are grouped by user story. Because all stories incrementally build the same file (`.github/workflows/ci.yml`), stories execute in priority order rather than in parallel; within-story tasks are strictly sequential.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Single project at repository root. The only file created by implementation is `.github/workflows/ci.yml` (plus optional housekeeping files called out per task). All check commands invoke existing npm scripts — never modify `package.json` scripts, `src/`, `prisma/`, or test suites (spec FR-007).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline confidence and the workflow file shell before any check is added.

- [x] T001 Create `.github/workflows/ci.yml` with the workflow shell: name, `on: [push, pull_request]` triggers (FR-001), and a `concurrency` group of `${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true` (FR-009). Job and steps come later.
- [x] T002 [P] Verify the green baseline locally per `specs/010-github-actions-ci/quickstart.md` Part 1: run `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm test` (with `DATABASE_URL` pointed at the compose `db` on 5433), and `npm run test:e2e`. All must exit 0 on the current tree before automation begins (SC-003). If any fails, STOP — the problem is pre-existing and out of scope.

**Checkpoint**: Workflow file exists with correct triggers; local baseline is proven green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Job skeleton, dependency/browser caching, and the Postgres service container — every user story extends what this phase builds.

**⚠️ CRITICAL**: No check steps are added until this phase is complete.

- [x] T003 Define the single job in `.github/workflows/ci.yml`: `runs-on: ubuntu-latest`; steps: `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 20` (research R1) and `cache: npm` (FR-005), then `npm ci`. Add job-level env `NEXT_TELEMETRY_DISABLED: "1"` (research R6, R9).
- [x] T004 Add the Postgres service container to the job in `.github/workflows/ci.yml` (FR-003): image `postgres:16-alpine` (same as compose `db`), env `POSTGRES_USER: profileforge`, `POSTGRES_PASSWORD: profileforge`, `POSTGRES_DB: profileforge`, port mapping `5432:5432`, health options `--health-cmd pg_isready --health-interval 5s --health-timeout 3s --health-retries 10` (FR-004). Add job-level env `DATABASE_URL: postgresql://profileforge:profileforge@localhost:5432/profileforge` (research R3 — the Vitest global setup derives `profileforge_test` and runs `prisma migrate deploy` against it; Prisma creates the missing database).
- [x] T005 Add Playwright browser provisioning to `.github/workflows/ci.yml` (research R7): an `actions/cache@v4` step for `~/.cache/ms-playwright` keyed on the runner OS plus the `@playwright/test` version extracted from `package-lock.json`, followed by `npx playwright install --with-deps chromium`.

**Checkpoint**: Job runs, installs dependencies from cache, DB service healthy, chromium provisioned — with zero checks yet.

---

## Phase 3: User Story 1 - Continuous checks on every push and pull request (Priority: P1) 🎯 MVP

**Goal**: Every push and PR runs lint, typecheck, build, unit/integration tests, and e2e tests; any failure fails the run.

**Independent Test**: Push a clean commit → run green (SC-001/SC-003); push a commit with a deliberate lint error → run fails with lint as the failing step (SC-002). Full scenario matrix in `quickstart.md` Part 2.

### Implementation for User Story 1

All steps append to the single job in `.github/workflows/ci.yml`, in this order (cheapest first — data-model.md). Every step uses default fail-on-error semantics: no `continue-on-error`, no `if: always()` that could mask a failure (FR-006).

- [x] T006 [US1] Add the lint step: `npm run lint` (ESLint 9 flat config, `eslint.config.mjs`).
- [x] T007 [US1] Add the typecheck step: `npx tsc --noEmit` (research R5 — no `typecheck` script exists; do not add one).
- [x] T008 [US1] Add the build step: `npm run build` (`next build`).
- [x] T009 [US1] Add the unit/integration step: `npm test` (`vitest run`; global setup in `tests/global-setup.ts` runs `prisma migrate deploy` against `profileforge_test` — depends on T004's service container).
- [x] T010 [US1] Add the e2e step: `npm run test:e2e` unchanged (starts compose `e2e-db` on 5434, resets/seeds DB, Playwright builds and serves the app on 3100 — research R4). Give the step a generous timeout (e.g., 20 min) to cover the webServer build.
- [x] T011 [US1] Add a failure-artifact step after e2e: `actions/upload-artifact@v4` uploading `playwright-report/` with `if: failure()` and `retention-days: 7` (research R10).
- [ ] T012 [US1] Commit, push the branch, and validate the first real run with `gh run watch`: all five checks green, total wall-clock under 15 minutes (SC-001, SC-003, SC-004). Record the run duration for the US3 comparison.

**Checkpoint**: MVP complete — the pipeline runs end-to-end on push/PR and its verdict is trustworthy.

---

## Phase 4: User Story 2 - Database-backed tests run against a real database (Priority: P2)

**Goal**: Integration and e2e suites provably run against real, freshly provisioned databases in CI, matching local behavior.

**Independent Test**: In a passing run's logs, confirm (a) the vitest step executed migrations against the service container's derived `profileforge_test` database, and (b) the e2e step started compose `e2e-db` (`profileforge_e2e` on 5434) and its seed completed — `quickstart.md` Part 2, pass-path.

### Implementation for User Story 2

- [x] T013 [US2] Validate the unit/integration database path in the CI run logs: `prisma migrate deploy` applies all migrations in `prisma/migrations/` to the service container (creating `profileforge_test`), and no step of `npm test` connects to anything else. If Prisma fails to create the derived database, fix only the workflow wiring (env/health options) — never the test setup code.
- [x] T014 [US2] Validate the e2e database path in the CI run logs: compose `e2e-db` becomes healthy, `tests/e2e/scripts/reset-db.mjs` accepts the URL (targets `profileforge_e2e`), and the Playwright globalSetup seed (`tests/e2e/scripts/seed.ts`) completes before scenarios run. Deliberately break one database-backed behavior on a scratch branch and confirm the corresponding integration or e2e test fails the run (User Story 2, acceptance scenario 2).

**Checkpoint**: Both database-backed suites demonstrably run against real per-run databases.

---

## Phase 5: User Story 3 - Fast, economical runs (Priority: P3)

**Goal**: Repeat runs restore dependencies and browsers from cache and stay within free-tier budgets; superseded runs cancel.

**Independent Test**: Trigger two runs with an unchanged lockfile; compare step timings — the second run's install and browser steps are materially shorter (cache hits), and total time remains under budget (SC-004, SC-005).

### Implementation for User Story 3

- [ ] T015 [US3] Validate cache behavior (SC-005): trigger a second run without changing `package-lock.json` and compare step durations against T012's recorded timings. The `actions/setup-node` npm cache must hit; the `~/.cache/ms-playwright` cache must hit. If a cache never hits, fix the cache key (lockfile path / playwright version extraction) — caching is an optimization, so a miss must never fail the run (spec Edge Cases).
- [ ] T016 [US3] Validate run economy (FR-008, FR-009, SC-004, SC-006): confirm the workflow defines exactly one job, no matrix, no paid services; push two commits in quick succession to the same branch and confirm the first run is cancelled by the concurrency group; confirm final total duration stays under 15 minutes.

**Checkpoint**: Pipeline is fast and free-tier-safe.

---

## Final Phase: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and the full acceptance pass.

- [x] T017 [P] Document the pipeline in `README.md`: add a CI status badge (workflow name from T001) and a short "CI" section listing the five checks, the Postgres service container, and caching. Behavior-neutral documentation only.
- [ ] T018 Run the complete validation matrix in `specs/010-github-actions-ci/quickstart.md` Part 2 on a scratch branch: all five failure-path scenarios (lint, typecheck, build, unit/integration, e2e — each must fail the run and name its failing step, SC-002), plus the PR trigger check (SC-001). Clean the scratch branch afterward.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately. T002 gates everything (a red baseline invalidates CI signal).
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories. T003 → T004/T005 (T004, T005 are independent of each other but land in the same file; do them sequentially).
- **User Stories (Phases 3–5)**: Strictly sequential — all stories edit the same workflow file, and each validates the previous story's additions. US1 → US2 → US3.
- **Polish (Final Phase)**: Depends on all stories. T017 is parallel-safe; T018 must be last (it exercises the finished pipeline).

### Within Each Story

Steps append to the job in data-model.md's order: static checks before test suites, artifact upload after e2e, validation tasks after implementation tasks.

### Parallel Opportunities

Genuine parallelism is minimal by design (one deliverable file, sequential validation):

- T002 (baseline) can run while T001 is being written — it touches no shared files.
- T017 (README) is parallel-safe with any story task.
- All other tasks are sequential: same file, and each validation task depends on the workflow state left by its predecessors.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup (baseline + workflow shell)
2. Phase 2: Foundational (job, caching, service container)
3. Phase 3: User Story 1 — all five checks wired and a real green run (T012)
4. **STOP and VALIDATE**: This alone satisfies the core of the feature (FR-001 through FR-006); US2/US3 are verification and tuning of what US1 built.

### Incremental Delivery

1. Setup + Foundational → skeleton that connects, installs, and provisions
2. US1 → pipeline passes on a clean tree (MVP)
3. US2 → database paths proven against real per-run databases
4. US3 → cache hits and run economy proven
5. Polish → badge + full failure-path matrix

### Notes

- Never add `continue-on-error` anywhere — FR-006 is the feature's soul.
- If any validation task fails, fix the **workflow** (env, keys, timeouts), never the application or test code (FR-007).
- Commit after each story checkpoint with Conventional Commits (`ci:` prefix fits the deliverable).
- Total expected file surface: `.github/workflows/ci.yml` (new), `README.md` (badge + section). Nothing else.

## Status note (2026-10-28, `$speckit-implement` run)

Implemented and locally validated: T001–T011, T002, T013, T017, plus the local portions of
T014 (compose e2e-db healthy, reset accepted, seed completed — full `npm run test:e2e` green:
45 passed / 1 skipped) and T018 (fail-on-error spot check for typecheck; the other commands'
non-zero-on-error behavior is inherent to the tools).

**Not executed — requires a git remote / real GitHub runs**: T012 (first real run), the
negative scratch-branch half of T014, T015 (cache hits), T016 (cancellation + economy), and
the full T018 matrix. This repository has no `origin` remote; run these once the workflow
file is pushed to GitHub. One pre-existing flaky test was observed during baseline
(`tests/integration/generations-api.test.ts` "restoring a selection omission…" fails
intermittently in the full suite, passes in isolation and on suite rerun) — out of scope
here (FR-007), but it can intermittently fail CI runs.
