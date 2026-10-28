# Implementation Plan: Slice 2 — JD Analysis & Deterministic Matching

**Branch**: `002-jd-matching` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

**Input**: `specs/002-jd-matching/spec.md` (slice spec, decisions binding), parent `specs/001-ats-cv-tailoring/spec.md`, `ProfileForge-Specification.md` §4–§6, and the existing Slice-1 codebase (Next.js 16 App Router + TS strict, Prisma 7 + PostgreSQL, zod 4, LLM router with task registry, profile repository with versioning).

**Slice scope**: JD paste + language detection → LLM requirement extraction → user requirement review → deterministic matching (exact → approved-alias → semantic, evidence-validated) → persisted MatchReport with history and re-run. No generation (Slice 3).

## Summary

Slice 2 adds a `JobAnalysis` aggregate to the existing foundation: the user pastes an FR/EN job description (deterministic language detection reused from Slice 1's `franc` helper), an `extractRequirements` LLM task (economy tier, via the existing router) produces a structured requirement list the user corrects before matching, and a **deterministic matching engine** (pure code) assigns every requirement a status, method, and evidence: exact matches by normalized (case/accent-insensitive) equality against profile skill/certification names and `skillsUsed` entries; alias matches against the union of a new versioned built-in bilingual alias seed file and the profile's per-skill approved aliases; then a `semanticProposals` LLM task proposes matches for non-hard requirements only, each proposal citing profile entry IDs that the engine validates (dangling refs are dropped and counted). The engine computes statuses, per-requirement credits, and the clarified 60/30/10 score as pure functions, and the report is persisted on the analysis, pinned to the profile version. A jobs UI (list + wizard + report view) completes the slice.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 20 LTS — unchanged from Slice 1.

**Primary Dependencies**: existing stack only — Next.js App Router, Prisma 7 + PostgreSQL, zod 4, `franc`, the existing `callLLM` router/registry, `@/lib/db`, error envelope. No new npm packages.

**Storage**: PostgreSQL via Prisma — new `JobAnalysis` and `JobRequirement` models (see data-model.md); MatchReport stored as JSONB on the analysis.

**Testing**: vitest, same layout as Slice 1 — pure-function unit tests for the matching engine and score (deterministic table-driven tests), router tests with mocked fetch for the two new tasks, integration tests for the jobs API against the test DB.

**Target Platform**: local-first web app on localhost; no auth.

**Project Type**: single Next.js app (extends Slice 1 structure).

**Performance Goals**: JD create + language detection < 1 s; requirement extraction (LLM) < 60 s; semantic proposals (LLM) < 60 s; deterministic match + score < 1 s; report view instant from persisted JSONB.

**Constraints**: per-run cost cap applies to the two LLM calls (one runId per analysis run); payload minimization (JD text + profile digest only); no silent truncation (JD > 100k chars refused with guidance); established error taxonomy reused; semantic never touches hard constraints.

**Scale/Scope**: dozens of stored analyses; ~10–40 requirements per JD; profile digest capped (top entries by recency).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` remains an unfilled template — no ratified gates. Governing constraints are the slice spec (binding restatements in FR-005/FR-007/FR-009) and the parent spec. **Post-Phase-1 re-check: unchanged — no gates to violate.**

## Project Structure

### Documentation (this feature)

```text
specs/002-jd-matching/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── api.md           # jobs API endpoints
│   ├── matching-engine.md # deterministic engine + score contract
│   └── llm-tasks.md     # extractRequirements + semanticProposals task contracts
└── tasks.md             # Phase 2 output ($speckit-tasks — NOT created here)
```

### Source Code (additions to the existing tree)

```text
prisma/
└── (schema.prisma gains JobAnalysis + JobRequirement; new migration)

src/lib/text/
└── normalize.ts         # shared case/accent-insensitive normalization (moved from files/storage.ts, re-exported)

src/lib/matching/
├── aliases.ts           # versioned built-in bilingual alias seed + union resolution
├── engine.ts            # deterministic exact/alias layers, semantic validation, statuses
├── score.ts             # pure score computation (clarified formula, verbatim)
└── digest.ts            # compact profile digest for the semantic task

src/lib/llm/tasks/
├── extractrequirements.ts   # registry task "extractRequirements"
└── semanticproposals.ts     # registry task "semanticProposals"

src/lib/jobs/
├── schemas.ts           # zod: JobAnalysis DTO, requirement inputs, MatchReport shape
└── repository.ts        # analysis CRUD, requirement-list replace, report persist, re-run

src/app/api/jobs/
├── route.ts                       # POST create (paste + detect), GET list
├── [id]/route.ts                  # GET analysis, PATCH language, DELETE
├── [id]/extract/route.ts          # POST → run extractRequirements
├── [id]/requirements/route.ts     # PUT full corrected list (authoritative)
├── [id]/match/route.ts            # POST → engine + semantic + score + persist
├── [id]/confirm/route.ts          # POST {requirementId} → user-confirm a hard-constraint match
└── [id]/rerun/route.ts            # POST → new analysis pinned to current profile version

src/app/jobs/
├── page.tsx             # paste + history list
└── [id]/page.tsx        # wizard: extract → requirement review → match report

tests/
├── unit/matching-engine.test.ts   # exact/alias/semantic-validation/status tables
├── unit/score.test.ts             # formula table incl. bucket shift + evidence bonus
├── unit/llm-jobs-tasks.test.ts    # two tasks, mocked fetch
└── integration/jobs-api.test.ts   # endpoints with test DB, mocked LLM
```

**Structure Decision**: extends the Slice-1 single app unchanged; `lib/matching` mirrors the "Deterministic Analysis" module of the source document, and both LLM tasks slot into the existing registry (the router itself needs no changes — `extractRequirements` was reserved; `semanticProposals` is the documented deterministic split of the source doc's `generateMatchReport`).

## Implementation Sequence (guidance for `$speckit-tasks`)

1. **Scaffold**: shared normalization extraction (`lib/text/normalize.ts`), matching schemas + zod shapes.
2. **Data model**: Prisma `JobAnalysis`/`JobRequirement` + migration; jobs repository (CRUD, requirement replace, report persist, rerun) with integration tests.
3. **Matching core (pure)**: `aliases.ts` seed + union; `engine.ts` exact/alias layers + semantic validation + statuses; `score.ts` — table-driven unit tests first (these are the deterministic heart; SC-004/SC-005 live here).
4. **LLM tasks**: `extractrequirements.ts` + `semanticproposals.ts` (registry entries, economy tier, payload minimization, repair via existing router) with mocked router tests.
5. **API routes**: the seven endpoints, reusing the error envelope; per-run cost cap via shared runId for extract+match.
6. **Match orchestration**: `[id]/match` wiring — engine layers → semantic task → validation → credits → score → persist (pinned profile version); degradation to exact/alias-only with notice on semantic failure.
7. **UI**: `/jobs` paste + history; `/jobs/[id]` wizard with requirement review editor and report view (evidence drill-down, keywords, copyable text, confirm action, re-run).
8. **Validation pass**: quickstart scenarios incl. cross-language JD↔profile, hard-constraint gap honesty, re-run pinning; full suite + lint + build.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — no constitution gates exist (placeholder constitution), no violations introduced.
