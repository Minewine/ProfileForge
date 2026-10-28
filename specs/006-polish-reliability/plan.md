# Implementation Plan: Polish & Reliability Slice

**Branch**: `006-polish-reliability` | **Date**: 2026-10-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-polish-reliability/spec.md`

## Summary

Fix the UX/reliability gaps the feature-005 smoke test exposed, without touching the
generation pipeline's semantics: (1) AI-provider and pipeline failures become
cause-specific, actionable messages (server-side message text is the single source; the
provider's status/detail is retained for diagnosis); (2) the blocked-export state
explains itself — which gate is closed, what each flag kind means in one sentence, and
the edit/remove/confirm path; (3) generation and data-loading get persistent visible
progress; (4) dual-template export (ATS + designed) is confirmed clean across FR/EN/DE
with tests, closing any gap found. No schema changes; all work is message/UX/presentational
plus targeted test coverage.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 20 (Next.js 16.4.2 App Router, Turbopack; React 19)

**Primary Dependencies**: next (App Router, client components), zod, @prisma/client, pdf-lib (PDF), docx (DOCX), tailwind v4; no new runtime dependencies planned

**Storage**: PostgreSQL 16 via Prisma (`profileforge` dev DB, `profileforge_e2e` e2e DB); no schema migration in this feature

**Testing**: vitest (unit + integration, 303 tests), Playwright e2e (15 passing + 1 key-gated skip), eslint flat config, `npx tsc --noEmit`

**Target Platform**: single-user local web app (Linux/macOS dev; Chromium via Playwright)

**Project Type**: web application (Next.js App Router; API routes under `src/app/api/**` are server modules, pages under `src/app/**` are client components by convention)

**Performance Goals**: error/loading states render within one poll tick (POLL_MS = 1500 in the generation panel); no additional network requests introduced for any UX state

**Constraints**: client components must not import server modules that pull `node:crypto`/`@prisma` (established convention — see the local view-type comments in `GenerationPanel.tsx`); fail-closed Fact Guard semantics are inherited and NOT relaxed; all existing 303 tests + 15 e2e must stay green

**Scale/Scope**: single user; ~6 files touched in `src/`, 1 new shared client module, test extensions in 4–6 existing suites + possibly 1 new unit suite for the message maps

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template (no ratified principles) — no
project-specific gates apply. Inherited workspace rules honored: tests-first per slice
convention, payload/schema conformance tests parse against REAL schemas, deterministic
pipeline behavior untouched (this feature changes messages and presentation only — no
plan/draft/guard/fit logic edits), `next dev`-maintained AGENTS.md block respected
(consult `node_modules/next/dist/docs/` before touching Next APIs). Post-design
re-check: no violations — research R1–R6 keep all pipeline semantics frozen.

## Project Structure

### Documentation (this feature)

```text
specs/006-polish-reliability/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R6 decisions (error architecture, gate UX, progress, export matrix)
├── data-model.md        # Phase 1: derived view entities (gate state, flag explanations, failure notices); no schema change
├── quickstart.md        # Phase 1: manual + automated validation scenarios
├── contracts/
│   ├── error-messages.md    # error envelope contract + per-code message/action matrix
│   ├── fact-guard-ux.md     # export gate states + flag explanation strings
│   └── ui-states.md         # loading/progress/disabled-with-reason contract
└── tasks.md             # Phase 2 output ($speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── lib/
│   ├── llm/errors.ts                     # [US1] per-code message text (cause-specific, actionable)
│   ├── llm/router.ts                     # [US1] retain provider status/detail on failure (diagnostics)
│   ├── client-messages.ts                # [NEW, US1+US2] client-safe maps: LLM code → {message, action}, flag code → explanation
│   ├── profile/repository.ts             # [US1] overlap conflict message rewrite (no phantom "verify")
│   └── generation/repository.ts          # [US2] computeDownloadable may expose gate reasons (read-only change if needed)
├── components/generation/
│   ├── GenerationPanel.tsx               # [US2+US3] structured gate-state download area, progress indicator, disabled-with-reason
│   ├── ClaimReview.tsx                   # [US2] flag-kind explanations on each row
│   └── OmissionsList.tsx                 # [US3] consistent disabled-with-reason (reuse shared helpers)
├── app/
│   ├── jobs/[id]/page.tsx                # [US1+US3] failure panel formatting; loading state on data fetch
│   ├── upload/page.tsx                   # [US1] reuse shared LLM error rendering
│   └── jobs/page.tsx                     # [US1] shared error rendering for create/extract failures
└── components/ui/                        # [US3] spinner/progress primitive if not reusable from existing set

tests/
├── unit/llm-errors.test.ts              # [NEW, US1] message map: every LLM code → actionable text w/ action pointer
├── unit/client-messages.test.ts         # [NEW, US1+US2] flag explanations cover every emitted code; no node imports
├── unit/generation-factguard.test.ts    # [US2] no new codes emitted unexplained (shared-map completeness)
├── integration/generations-api.test.ts  # [US1] overlap message content; provider detail retained in logs on failure
├── integration/... (template matrix)    # [US4] FR/EN/DE × {ats, designed} download matrix (extends existing suites)
└── e2e/08-generation-views.spec.ts      # [US2+US3] blocked-export explanation + progress indicator visible
```

**Key design decisions** (full rationale in [research.md](./research.md)):

- **Server messages are the single source of truth** (R1): every route already funnels
  errors through `errorResponse` → `{error: {code, message, details}}`, and every client
  page reads `error.message`. Cause-specific text goes into the throw sites / `errors.ts`
  table; a small client-side map adds the *action pointer* (e.g., "open Settings") keyed
  by code, so messages stay testable server-side without duplicating prose.
- **Gate state is derived, not stored** (R2): the download area computes its explanation
  from data already in the polled payload (`summary.blockers`, `layersRun.semantic`,
  `extractionCheck`) — no API change. Flag explanations are a static client-safe map
  keyed by flag code; a unit test cross-checks map completeness against the codes the
  Fact Guard actually emits.
- **Progress is presentational** (R3): a pulse/spinner attached to the existing status
  badge for queued/running plus disabled-with-`title`-reason on controls. No new endpoint,
  no stage streaming (explicit spec assumption).
- **Dual-template export needs verification, not rebuilding** (R4): artifacts are baked
  per version at persist time, so template fidelity is by construction; the gap is test
  coverage of the FR/EN/DE × template download matrix, added at the integration level.
