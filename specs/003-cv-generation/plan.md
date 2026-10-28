# Implementation Plan: Slice 3 — Evidence-Aware CV & Cover Letter Generation (Fact Guard + ATS Export)

**Branch**: `003-cv-generation` | **Date**: 2026-10-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-cv-generation/spec.md`; canonical schemas/contracts from `ProfileForge-Specification.md` §4 (GeneratedCVContent, ValidationReport), §6 (generateTailoredCV, generateCoverLetter, factGuard, renderCV), §7; settled decisions from `specs/001-ats-cv-tailoring/spec.md` Clarifications (2026-10-21); upstream artifact contract from `specs/002-jd-matching/spec.md` (finalized JobAnalysis with stored MatchReport pinned to a profile version).

**Slice scope**: From a finalized (matched) JobAnalysis, run an async generation job that deterministically plans evidence-ranked content, LLM-drafts it in the chosen output language, validates every material claim through a two-layer Fact Guard, renders a single-column ATS template to a text-layer PDF that must pass the two-level extraction gate, and persists inspectable/reversible omissions and document versions. Cover letter reuses the same pipeline with a tone setting and plain-text output.

## Summary

Slice 3 adds the generation half of the product: a `GenerationJob` state machine (the codebase's first true async job — DB-backed status, in-process execution, polling, cancel/retry) that turns a matched analysis into a versioned `GeneratedDocument`. The deterministic-first architecture mirrors Slice 2's propose–validate split: a **deterministic content plan** ranks profile entries (relevance from MatchReport evidence, evidence strength, impact, recency) and fixes each item's provenance; the **premium-tier LLM only rephrases/translates plan items keyed by id**, so it cannot introduce unkeyed claims; a **two-layer Fact Guard** (deterministic reference/numeric checks + economy-tier semantic fidelity, fail-closed) gates export; the **pdf-lib single-column template** renders a text-layer PDF that must pass the **two-level extraction gate** (structural 100% + ≥95% word recovery, reusing `unpdf` and the existing containment checker). Omissions are recorded by the page-budget fitting loop and are restorable as must-include items; claim-level edit/remove/confirm resolution is persisted with confirmation fingerprints carried across regeneration.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 20, Next.js 16 App Router (repo-locked; consult `node_modules/next/dist/docs/` per workspace AGENTS.md before touching route APIs).

**Primary Dependencies**: Existing stack only, plus **promoting two existing devDependencies to dependencies: `pdf-lib` (PDF rendering) and `docx` (best-effort DOCX export)** — both already used by `scripts/make-fixtures.mjs`; no brand-new npm packages. Reused as-is: `unpdf` (extraction gate), `zod` 4 (schemas + LLM structured outputs), `franc`, the `callLLM` task registry with `economy`/`premium` tiers and per-runId cost cap (`src/lib/llm/router.ts`), `@/lib/validation/sourceContainment.checkContainment` (≥0.95 word-recovery rule), `@/lib/text/normalize.normalizeText`, `@/lib/api/errors` envelope.

**Storage**: PostgreSQL via Prisma 7 (new models `GenerationJob`, `GeneratedDocument`, `GeneratedDocumentVersion`; content/report/artifacts as JSONB — same pattern as `JobAnalysis.matchReport`) plus artifact files on disk under `UPLOADS_DIR/generations/{versionId}/` (extends `src/lib/files/storage.ts` conventions).

**Testing**: vitest (node env, serial, 30 s timeout — see risk note in research R4), existing layout: `tests/unit/*.test.ts` pure-function suites + `tests/integration/*.test.ts` with mocked `callLLM`, direct handler invocation, per-test `clean()` truncation.

**Target Platform**: local-first single-user Next.js app on localhost; no auth, no multi-tenant.

**Project Type**: Extends the existing single Next.js application (Slices 1–2: profile, ingestion, job analysis).

**Performance Goals**: full CV generation job (2 premium + 1–2 economy LLM calls + render + gate) completes < 90 s typical; render + extraction gate < 5 s per attempt; job-status polling GET < 100 ms; document full-read GET < 200 ms.

**Constraints**: per-runId cost cap (default $0.50, hard stop) with usage displayed per run; minimized LLM payloads (digest-style inputs); Fact Guard fails closed (no unvalidated download ever); no fabricated content on any AI failure; page budget is a layout constraint, never a bullet quota; zero new runtime dependencies beyond the two promotions.

**Scale/Scope**: dozens of documents/versions; CV ≤ 3 rendered pages; ≤ ~200 claims and ≤ ~60 rendered content blocks per document; French/English outputs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` remains an unfilled template (verified 2026-10-22) — no ratified gates exist. Governing constraints are this slice's spec, the parent spec `specs/001-ats-cv-tailoring/spec.md` (incl. its Clarifications), and `ProfileForge-Specification.md` §2 guiding principles. Pre-Phase-0: nothing to violate. **Post-Phase-1 re-check: unchanged — no gates to violate; design decisions in `research.md` stay within the settled parent decisions.**

## Project Structure

### Documentation (this feature)

```text
specs/003-cv-generation/
├── plan.md                      # This file ($speckit-plan output)
├── research.md                  # Phase 0 — design decisions R1–R12
├── data-model.md                # Phase 1 — entities, stored JSONB shapes, state machines
├── quickstart.md                # Phase 1 — validation scenarios
├── contracts/
│   ├── api.md                   # HTTP surface for generation jobs/documents/downloads
│   ├── llm-tasks.md             # generateTailoredCV / generateCoverLetter / factGuard contracts
│   └── generation-pipeline.md   # stage machine, ranking, Fact Guard codes, fitting, extraction gate
└── tasks.md                     # $speckit-tasks output (NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
prisma/
└── schema.prisma                # + GenerationJob, GeneratedDocument, GeneratedDocumentVersion

src/lib/generation/
├── schemas.ts                   # zod: settings, content, claims, omissions, validation report, claim ids
├── repository.ts                # Prisma CRUD: jobs, documents, versions, confirmations
├── plan.ts                      # deterministic content plan + ranking + must-include pre-check
├── draft.ts                     # plan → LLM draft keyed merge (provenance passthrough, verbatim fallback)
├── factguard.ts                 # deterministic layer + semantic layer + report assembly
├── fit.ts                       # page-budget measure-and-demote loop → omissions
├── pipeline.ts                  # stage machine: pin → plan → draft → guard → render → gate → persist
├── verify.ts                    # two-level extraction gate (structural + containment)
├── artifacts.ts                 # disk storage for pdf/docx/txt + sha256/size metadata
└── render/
    ├── template.ts              # shared single-column primitives, heading maps, date format, sanitizer
    ├── cv.ts                    # CV renderer (pdf-lib)
    ├── letter.ts                # cover-letter renderer (pdf-lib)
    └── docx.ts                  # best-effort DOCX renderer

src/lib/llm/tasks/
├── generatetailoredcv.ts        # premium task, self-registering
├── generatecoverletter.ts       # premium task, self-registering
└── factguard.ts                 # economy task, self-registering

src/app/api/generations/
├── route.ts                     # POST create job (cv|cover_letter), GET list by analysisId
└── [id]/
    ├── route.ts                 # GET job + document summary (polling)
    ├── cancel/route.ts          # POST set cancelRequested
    ├── retry/route.ts           # POST re-enqueue failed/cancelled job
    ├── document/route.ts        # GET current version (content, flags, omissions, gate results)
    ├── document/claims/route.ts # PATCH edit claim text, DELETE remove claim
    ├── document/claims/[claimId]/confirm/route.ts   # POST user-confirm
    ├── document/omissions/[omissionId]/restore/route.ts  # POST mark must-include
    └── download/route.ts        # GET ?format=pdf|docx|txt — blocker-gated, PDF additionally gate-verified

src/app/jobs/[id]/
└── page.tsx                     # + generation panel (settings, job status, claim review, omissions, downloads)

src/components/generation/
├── GenerationPanel.tsx          # settings form + generate buttons + polling status
├── ClaimReview.tsx              # flags by severity, edit/remove/confirm actions
└── OmissionsList.tsx            # omissions with reasons + restore

tests/unit/generation-{plan,factguard,fit,verify,template,draft}.test.ts
tests/integration/generations-api.test.ts
```

**Structure Decision**: Single-project Next.js App Router layout (the repo's existing structure from Slices 1–2). All generation domain logic lives in a new `src/lib/generation/` module mirroring `src/lib/jobs/` and `src/lib/matching/`; LLM tasks follow the existing self-registering `src/lib/llm/tasks/` convention; API routes follow the existing `src/app/api/` envelope + direct-invocable handler pattern; UI extends the existing `/jobs/[id]` analysis page (generation is launched from a matched analysis) with new components under `src/components/generation/`.

## Implementation Sequence (guidance for $speckit-tasks)

1. **Foundations**: `src/lib/generation/schemas.ts` (content/claim/omission/validation zod schemas extending the existing `EvidenceRef`), Prisma models + migration, `repository.ts` (job/document/version CRUD, confirmation fingerprints), new error codes in `@/lib/api/errors`.
2. **Async job runner**: `pipeline.ts` stage machine + cancel/retry semantics + stale-running-job recovery; POST/GET/cancel/retry routes; polling contract per `contracts/api.md`.
3. **Deterministic plan**: `plan.ts` ranking (relevance/strength/impact/recency), skills list from MatchReport exact/alias matches in JD terminology, restored must-include pre-check (`PAGE_BUDGET_CONFLICT` early fail).
4. **LLM tasks + draft merge**: register the three tasks per `contracts/llm-tasks.md`; `draft.ts` keyed merge with provenance passthrough and verbatim fallback for unkeyed items.
5. **Fact Guard**: `factguard.ts` deterministic layer (dangling refs, numeric/date/duration identity, skill verification) + semantic layer wiring + fail-closed gate; claim PATCH/DELETE/confirm routes with re-validation.
6. **Rendering + fitting**: `render/template.ts` + `cv.ts`/`letter.ts` (pdf-lib, WinAnsi sanitization, bilingual headings, normalized dates) and `fit.ts` measure-and-demote loop recording omissions.
7. **Extraction gate + artifacts**: `verify.ts` two-level gate reusing `unpdf` + `checkContainment`; `artifacts.ts` + `render/docx.ts` + plain-text letter; download route with blocker/PDF gating and bounded re-render retries.
8. **UI**: `/jobs/[id]` generation panel, claim review, omissions list with restore, downloads with gate/blocker states.
9. **Omission restore + regeneration loop**: restore route, must-include application in `plan.ts`, version chaining, confirmation-fingerprint carryover.
10. **Test suites throughout** (tests-first per story, mirroring `specs/002-jd-matching/tasks.md` conventions): unit suites for plan/factguard/fit/verify/template/draft; integration suite for the generations API with mocked `callLLM` including every failure path in the spec's edge cases.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — no constitution gates exist (placeholder constitution), and no parent-spec decisions are violated. The only architectural addition (DB-backed async jobs) is required by spec FR-001 and is the lightest pattern that satisfies it (research R4).
