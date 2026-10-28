# Quickstart: Validating the CI Pipeline

Feature: `010-github-actions-ci`

How to prove the pipeline works end-to-end. The deliverable is `.github/workflows/ci.yml`; validation means (a) simulating its steps locally, then (b) observing real runs on GitHub.

## Prerequisites

- Node.js 20 with npm (lockfile: `package-lock.json`)
- Docker with Compose (for the e2e database)
- `gh` CLI authenticated to the repo (for observing runs), or the GitHub web UI
- The existing local setup already working: `docker compose up -d`, `.env` present

## Part 1 — Local simulation of the CI steps

Run the exact commands the workflow runs, in its order. Each command must exit 0 on a healthy tree (SC-003) and non-zero on a broken tree (SC-002).

### Unit/integration suite against a fresh database (simulates the service container)

```bash
# Simulates the Postgres 16 service container on localhost:5432
docker run -d --rm --name ci-db-sim -e POSTGRES_USER=profileforge \
  -e POSTGRES_PASSWORD=profileforge -e POSTGRES_DB=profileforge -p 5432:5432 postgres:16-alpine

export DATABASE_URL="postgresql://profileforge:profileforge@localhost:5432/profileforge"
npm ci          # clean, deterministic install (what CI runs)
npm test        # global setup runs prisma migrate deploy → profileforge_test, then vitest

docker stop ci-db-sim
```

Expected: migrations apply to the auto-created `profileforge_test` database and all Vitest suites pass. This validates the R3 decision (service container + `DATABASE_URL` is the only wiring).

### The static checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all exit 0 on the current tree.

### E2E suite (unchanged script, as CI runs it)

```bash
npm run test:e2e
```

Expected: compose `e2e-db` starts on 5434, DB resets and seeds, the app builds and serves on `:3100`, all Playwright scenarios pass.

## Part 2 — Real CI validation

Push the branch and inspect the run:

```bash
git push -u origin 010-github-actions-ci
gh run watch   # or: gh run list --workflow ci
```

Expected: one run for the push; all five checks (lint, typecheck, build, unit/integration, e2e) green; total time under 15 minutes.

### Failure-path scenarios (SC-002) — one commit each, on a scratch branch

| Scenario | Do | Expect |
|----------|----|--------|
| Lint fails | Add a file with a deliberate ESLint error (e.g., unused var per config) | Run fails; lint step is the failing step |
| Type error | Add a type-incorrect statement | Run fails at `tsc --noEmit` |
| Build breaks | Introduce an invalid import in a page | Run fails at `npm run build` |
| Unit/integration fails | Flip an assertion in one `tests/**/*.test.ts` | Run fails at the vitest step |
| E2e fails | Temporarily alter an expected e2e behavior | Run fails at the e2e step; Playwright HTML report artifact is attached to the run |

### Pass-path and economy scenarios

- **SC-001**: Open a PR from the scratch branch — a run triggers for the PR; merge-relevant checks all report.
- **SC-005**: Trigger a second run without touching `package-lock.json` — the install step restores from cache (compare step timings: cached run's "Install dependencies" is materially shorter than the cold run's) and the Playwright browser cache hits.
- **FR-009**: Push two commits in quick succession to the same branch — the first run is cancelled by the second (concurrency group), conserving free-tier minutes.

## Red flags (SC-003 — pipeline-caused failures)

- `prisma migrate deploy` failing to connect: the service container's health check (`pg_isready`) is missing or the `DATABASE_URL` port is wrong.
- `reset-db.mjs` refusing to run: the e2e `DATABASE_URL` doesn't target `profileforge_e2e` (must stay on 5434).
- E2e timing out on server start: the webServer build exceeded its 240 s budget — check runner speed, not app behavior.
- Cache never hits: lockfile path in the cache key doesn't match the repo's `package-lock.json` location.

If all Part 1 commands pass locally and the Part 2 pass/fail matrix behaves as expected, the feature meets its success criteria.
