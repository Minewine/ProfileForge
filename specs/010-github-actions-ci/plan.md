# Implementation Plan: GitHub Actions CI Pipeline

**Branch**: `010-github-actions-ci` | **Date**: 2026-10-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-github-actions-ci/spec.md`

## Summary

Add a single GitHub Actions workflow (`.github/workflows/ci.yml`) that runs on every push and pull request and executes the project's existing checks in one job on `ubuntu-latest`: ESLint (`npm run lint`), TypeScript (`npx tsc --noEmit`), production build (`npm run build`), the Vitest unit/integration suite (`npm test`, with Prisma migrations applied by the existing global setup), and the Playwright e2e suite (`npm run test:e2e`, which already provisions the isolated e2e database via Docker Compose). Dependencies are cached via `actions/setup-node` (npm cache keyed on `package-lock.json`) plus a Playwright browser cache; a Postgres 16 service container (matching the compose `db` image) backs the Vitest suite. No application code changes — only the workflow file and, at most, `.gitignore`/env-default housekeeping.

## Technical Context

**Language/Version**: TypeScript 5 on Node.js 20 (local dev runs Node 20.19.2; Next.js 16 requires ≥ 20.9)

**Primary Dependencies**: Next.js 16.4.2, React 19, Prisma 7.10.1 (`prisma-client` provider, `postgresql` datasource), ESLint 9 (flat config), Vitest 4, Playwright 1.64

**Storage**: PostgreSQL 16 (`postgres:16-alpine` in docker-compose; CI uses the same image as a service container)

**Testing**: Vitest (`npm test`; global setup runs `prisma migrate deploy` against a derived `profileforge_test` database) and Playwright (`npm run test:e2e`; compose `e2e-db` on host port 5434, database `profileforge_e2e`, seeded by `tests/e2e/scripts/seed.ts`, app under test built and started on port 3100 by the Playwright `webServer`)

**Target Platform**: GitHub-hosted `ubuntu-latest` runner (Docker + Compose preinstalled)

**Project Type**: Web application (Next.js App Router) with CI infrastructure as the deliverable

**Performance Goals**: A full pipeline run under 15 minutes wall-clock (spec SC-004); cached install step noticeably faster than a cold install (SC-005)

**Constraints**: Free tier only — one job per run, no self-hosted or paid runners, no repository secrets; any test/lint/type/build failure must fail the run

**Scale/Scope**: One workflow file; no changes to `src/`, `prisma/`, or test suites

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is still the unmodified Spec Kit template — no project-specific principles or gates are defined. No violations to evaluate; nothing constrains this feature.

**Post-Phase 1 re-check**: Design stayed within the spec's bounded scope (CI configuration + minimal supporting files, FR-007). No complexity added to the application. Pass.

## Project Structure

### Documentation (this feature)

```text
specs/010-github-actions-ci/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

`contracts/` is intentionally omitted: the deliverable is internal CI infrastructure with no external interfaces (no public API, CLI schema, or wire protocol). The workflow's observable contract — triggers, checks, and pass/fail semantics — is documented in the spec's functional requirements and in `data-model.md`.

### Source Code (repository root)

```text
.github/
└── workflows/
    └── ci.yml           # The single CI workflow (the feature's deliverable)

package.json             # Existing check scripts invoked as-is: lint, build, test, test:e2e
playwright.config.ts     # Existing e2e config (webServer builds + starts app on :3100)
docker-compose.yml       # Existing compose file; `e2e-db` service used by test:e2e
tests/global-setup.ts    # Existing vitest global setup: prisma migrate deploy → profileforge_test
tests/e2e/scripts/       # Existing e2e DB reset + seed scripts (reused unchanged)
```

**Structure Decision**: Single-project layout. The feature adds exactly one file (`.github/workflows/ci.yml`) and touches no existing source, configuration, or test files. All checks invoke existing npm scripts so the pipeline mirrors local development exactly (FR-007, FR-002).

## Complexity Tracking

No constitution violations and no structural complexity: one job, one workflow file, zero application changes.
