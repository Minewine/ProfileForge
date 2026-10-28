# Data Model: GitHub Actions CI Pipeline

Feature: `010-github-actions-ci` | Date: 2026-10-28

This feature adds no application data. Its "data" is the CI pipeline's observable model — the entities from the spec (Pipeline Run, Check) mapped onto concrete workflow mechanics. Database entities (users, profiles, CVs, etc.) are untouched by this feature.

## Entity: Pipeline Run

One execution of the workflow, triggered by `push` or `pull_request`.

| Aspect | Value |
|--------|-------|
| Identifier | GitHub run ID + `github.ref` + commit SHA |
| Trigger events | `push` (any branch), `pull_request` (opened/synchronize/reopen — the default set) |
| Concurrency group | `${{ github.workflow }}-${{ github.ref }}`; superseded runs cancelled (`cancel-in-progress: true`) |
| Runner | `ubuntu-latest`, single job |
| Environment | Node 20, Postgres 16 service container (`localhost:5432`, db `profileforge`), Docker/Compose for the e2e database |
| Outcome | `success` (all checks pass) or `failure` (any check errors) — no neutral/skipped path in scope |
| Typical duration | < 15 minutes (spec SC-004); cold run longer than cached run (SC-005) |

### State transitions

```text
(push/PR event) → queued → in_progress → completed:success
                                      → completed:failure   (any check step exits non-zero)
queued/in_progress → cancelled        (a newer run for the same ref starts — concurrency group)
```

## Entity: Check

One verification stage within a Pipeline Run. Each is a workflow step (or step group) whose non-zero exit fails the job (default GitHub Actions semantics — no `continue-on-error`, no `if: always()` escalation of failures).

| # | Check | Command | Backing environment | Failure means |
|---|-------|---------|---------------------|---------------|
| 1 | Lint | `npm run lint` (ESLint 9 flat config) | — | Lint error in changed tree |
| 2 | Typecheck | `npx tsc --noEmit` | — | Type error in changed tree |
| 3 | Build | `npm run build` (`next build`) | No DB needed | Production build broken |
| 4 | Unit/Integration tests | `npm test` (`vitest run`) | Postgres service container; global setup runs `prisma migrate deploy` → derived `profileforge_test` DB; `UPLOADS_DIR=./uploads-test` | Any test failure or migration failure |
| 5 | End-to-end tests | `npm run test:e2e` (compose `e2e-db` on `localhost:5434`, db `profileforge_e2e`; Playwright webServer builds + serves app on `:3100`, seeds DB) | Isolated e2e database + built app | Any e2e scenario failure, DB reset/seed failure, or app build/start failure |

Order within the job is lint → typecheck → build → unit/integration → e2e: cheapest, fastest-failing checks run first so a broken commit consumes minimal runner minutes (free-tier constraint).

## Supporting artifacts of a run

| Artifact | Source | Retained |
|----------|--------|----------|
| npm dependency cache | `actions/setup-node` `cache: npm`, keyed on `package-lock.json` | Managed by GitHub (7-day LRU eviction) |
| Playwright browser cache | `actions/cache` on `~/.cache/ms-playwright`, keyed on `@playwright/test` version from lockfile | Managed by GitHub |
| Playwright HTML report (incl. failure traces) | Uploaded only when the e2e check fails, ~7-day retention | Workflow artifact |

## Database provisioning map (per run)

| Suite | Database | Provisioning | URL (CI) |
|-------|----------|--------------|----------|
| Vitest | `profileforge_test` (derived from `DATABASE_URL` by `tests/global-setup.ts`) | Service container `postgres:16-alpine`, health-checked with `pg_isready`; Prisma `migrate deploy` creates the DB and applies migrations | `postgresql://profileforge:profileforge@localhost:5432/profileforge` |
| Playwright e2e | `profileforge_e2e` | Compose service `e2e-db` started by the existing `test:e2e` script; `reset-db.mjs` resets it (guards the URL), seed runs via Playwright globalSetup | `postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e` (hardcoded in `playwright.config.ts`) |

No schema, migration, or seed changes are introduced by this feature.
