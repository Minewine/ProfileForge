# Research: GitHub Actions CI Pipeline

Feature: `010-github-actions-ci` | Date: 2026-10-28

All unknowns resolved from the repository itself (package.json, configs, compose file) plus standard GitHub Actions capabilities. No open questions remain.

## R1. Node.js version for the CI runner

**Decision**: Pin `actions/setup-node` to Node.js `20` (resolves to latest 20.x).

**Rationale**: The local dev machine runs Node 20.19.2 (`node --version`), and Next.js 16.4.2 requires Node ≥ 20.9. Pinning the major version CI uses matches local behavior while still receiving security patches.

**Alternatives considered**:
- Node 22 (current LTS): also compatible, but drifts from the version the project is actually developed and tested against — a mismatch could surface as CI-only failures.
- Node 24: same drift concern; no benefit for a fast, simple pipeline.

## R2. Package manager and dependency caching

**Decision**: npm with the committed `package-lock.json` (`npm ci` for install); cache via `actions/setup-node`'s built-in `cache: npm` (keyed on the lockfile).

**Rationale**: The repo has `package-lock.json` and no other lockfiles or package-manager fields, so npm is the established tool. `npm ci` is deterministic and fails on lockfile drift, which supports FR-006's fail-on-error posture. The setup-node cache covers `~/.npm` and is keyed on the lockfile hash, satisfying FR-005 with zero extra actions.

**Alternatives considered**:
- `actions/cache` on `node_modules` directly: faster on hit but fragile (platform-specific binaries, stale artifacts); rejected as unnecessary complexity.
- Migrating to pnpm/yarn for cache speed: changes the project's tooling — out of scope (FR-007).

## R3. Which database provisions the Vitest unit/integration suite

**Decision**: A GitHub Actions **service container** running `postgres:16-alpine` — the same image and credentials as the compose `db` service (`profileforge`/`profileforge`, database `profileforge`) — exposed on `localhost:5432`, with a `pg_isready` health check so the job waits for readiness (FR-004).

**Rationale**: The Vitest global setup (`tests/global-setup.ts`) derives `profileforge_test` from `DATABASE_URL` and runs `npx prisma migrate deploy` against it; Prisma creates the target database if it does not exist and the container's `POSTGRES_USER` is a superuser, so a fresh service container needs no manual database creation. Exporting `DATABASE_URL=postgresql://profileforge:profileforge@localhost:5432/profileforge` as a job-level env var is the only wiring needed — no `.env` file, no secrets (FR-010).

**Alternatives considered**:
- Reusing Docker Compose (`db` service, host port 5433) for this suite too: works, but the user explicitly asked for a service container, and the service-container form is simpler (no compose lifecycle in the main job).
- Emulating the DB with mocks: violates the spec's User Story 2 (results must match local behavior).

## R4. Which database provisions the Playwright e2e suite

**Decision**: Keep the existing `npm run test:e2e` script unchanged. It starts the compose `e2e-db` service (postgres 16 on host port 5434, database `profileforge_e2e`), runs `tests/e2e/scripts/reset-db.mjs`, and launches `playwright test`; the Playwright `webServer` builds the app and starts it on port 3100 pointed at that database. Docker and Compose are preinstalled on `ubuntu-latest`, so this works in CI as-is.

**Rationale**: The e2e database is deliberately physically isolated (port 5434, own volume, guarded by `reset-db.mjs`'s URL check) per spec 004. Reusing the existing script is the minimal-diff option (FR-007) and guarantees CI runs the identical flow developers run locally — supporting FR-003 and SC-003.

**Alternatives considered**:
- A second GH service container mapped to host port 5434: possible, but requires bypassing the `test:e2e` package script and duplicating its reset logic — more configuration, more drift risk.

## R5. Typecheck invocation

**Decision**: Run `npx tsc --noEmit` as a dedicated step.

**Rationale**: `package.json` has no `typecheck` script; `tsc --noEmit` against the existing `tsconfig.json` is the standard non-emitting check. `next build` also type-checks, but a standalone step gives an unambiguous, early failure signal (FR-006, User Story 1 scenario 5).

**Alternatives considered**:
- Adding a `typecheck` script to package.json: touching package.json is more application-adjacent than needed; a direct `npx tsc --noEmit` step is equivalent. (A task may still add the script if implementers prefer symmetry with existing scripts — behavior-neutral either way.)
- Relying on `next build` alone: conflates type errors with build errors in reporting.

## R6. Build check vs. the e2e webServer's build

**Decision**: Keep an explicit `npm run build` step before the test suites, and accept that the Playwright `webServer` runs `npm run build` again during e2e.

**Rationale**: The explicit step makes build failures a clearly reported, individually named check (User Story 1, scenario 5) and fails fast before minutes of test execution. The duplicate build inside e2e costs roughly a minute but requires no changes to `playwright.config.ts` (`reuseExistingServer: !process.env.CI` already forces a fresh server in CI). Config-file surgery to share the build was rejected as application/test-behavior-adjacent churn.

**Alternatives considered**:
- Skipping the standalone build step and letting e2e's webServer be the build check: saves ~1–2 min but loses distinct reporting and delays failure discovery.
- Setting `NEXT_TELEMETRY_DISABLED=1` in CI env: harmless speed/quiet tweak, applied as a CI-only env default (no app behavior change).

## R7. Playwright browsers in CI

**Decision**: Cache the Playwright browser install (`~/.cache/ms-playwright`) with `actions/cache`, keyed on the `@playwright/test` version from the lockfile; install with `npx playwright install --with-deps chromium` (matching the existing `e2e:install` script's chromium-only choice, plus OS dependencies which CI runners need).

**Rationale**: Chromium is the only browser the project installs locally (`e2e:install`), so CI installs only chromium — smaller, faster, and consistent. The cache turns a ~1 min browser download into a cache restore on repeat runs (SC-005). `--with-deps` installs the apt libraries chromium needs on the runner image.

**Alternatives considered**:
- Installing all browsers: slower, unnecessary.
- No browser cache: works, but re-downloads ~150 MB every run against the free-tier time budget.

## R8. Run economy (free tier)

**Decision**: One job total; add a `concurrency` group (`github.workflow` + `github.ref`) with `cancel-in-progress: true` so a rapid series of pushes to the same branch supersedes its own queued/running runs (FR-009, FR-008).

**Rationale**: A single sequential job minimizes parallel-minute consumption and keeps the workflow trivially readable. Cancellation is safe: each run is self-contained (fresh DB, fresh builds), so a superseded run's result is worthless.

**Alternatives considered**:
- Matrix builds (Node versions, OS): pure cost for this project's purpose; rejected.
- Separate jobs per check with `needs` chains: clearer per-check badges but pays N× checkout/install; rejected for free-tier economy (a documented tradeoff — per-step reporting within one job still identifies the failing stage).

## R9. Env defaults and secrets

**Decision**: Set all CI env inline in the workflow: `DATABASE_URL` (service container), `UPLOADS_DIR: ./uploads-test` is already forced by the Vitest setup file (`tests/setup-env.ts`) for unit/integration and by the Playwright config for e2e, `NEXT_TELEMETRY_DISABLED: 1`. No `APP_SECRET`, no `OPENROUTER_API_KEY` — nothing in the test suites requires real credentials (the LLM router reads keys from settings/env, and no test exercises a live LLM call).

**Rationale**: FR-010 requires zero stored secrets. Environment defaults inline in the workflow are visible, versioned, and non-sensitive.

**Alternatives considered**: Repository secrets / environments: unnecessary attack surface and setup burden; rejected.

## R10. Artifacts on failure

**Decision**: Upload the Playwright HTML report (`playwright-report/`) as a workflow artifact with `if: failure()` on the e2e step, short retention (e.g., 7 days).

**Rationale**: E2E failures are the hardest to diagnose from logs (traces are `retain-on-failure` inside the report); a small artifact makes CI failures actionable. Unit/integration failures are fully visible in console output, so no artifact there.

**Alternatives considered**: Always-upload traces/screenshots: larger artifacts and retention cost on the free tier; rejected.
