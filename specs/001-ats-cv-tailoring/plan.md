# Implementation Plan: CV Ingestion & Structured Profile Foundation (Slice 1)

**Branch**: `001-ats-cv-tailoring` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-ats-cv-tailoring/spec.md` (clarified, bilingual), `ProfileForge-Specification.md` (authoritative product reference), user-locked tech stack.

**Slice scope** (from the plan request): Profile schema with IDs, versioning, bullet-level provenance; profile editor (full CRUD + autosave); CV upload (PDF/DOCX) → parseCV with YYYY-MM date normalization and low-confidence flags; French/English language detection with stored metadata; OpenRouter key handling + LLM router; basic validation that every material claim links to profile evidence. Generation, matching, templates, and PDF export belong to later slices.

## Summary

Slice 1 delivers the profile foundation everything else consumes: a single-user, local-first Next.js application in which a user uploads a French or English CV (PDF/DOCX), the text is extracted per page (unpdf/mammoth), the language is detected (franc) and stored, an LLM task (`parseCV` via OpenRouter structured outputs) converts the text into a structured profile draft with normalized dates and confidence flags, a **zero-invention containment check** verifies every parsed bullet against the extracted source text before import, and the user reviews/edits the profile in a full-CRUD autosaving editor with bullet-level provenance. A minimal LLM router handles the OpenRouter key (env var or encrypted setting), model selection (two-tier defaults), per-run cost tracking with a $0.50 cap, and actionable error mapping.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 20 LTS.

**Primary Dependencies**: Next.js (App Router) + React; Prisma + PostgreSQL; Tailwind CSS + shadcn/ui; unpdf (per-page PDF text extraction); mammoth (DOCX → text/HTML); franc (FR/EN language detection); zod (all contracts: API payloads, LLM outputs, domain types). `@react-pdf/renderer` is locked for later slices and is not installed in this slice.

**Storage**: PostgreSQL (profile, provenance, settings, usage logs) + local filesystem (`uploads/`, gitignored) for original CV files.

**Testing**: vitest (unit + integration via direct route-handler invocation with a test database); fixture set includes English and French CVs (PDF + DOCX) and an image-only PDF.

**Target Platform**: Local-first web application running on localhost (Linux/macOS); no auth.

**Project Type**: Web application — single Next.js project (App Router unifies UI and API route handlers; no separate backend/frontend split).

**Performance Goals**: CV upload + text extraction + language detection < 5 s; parseCV (LLM-bound) < 120 s with visible progress state; editor autosave round-trip < 500 ms.

**Constraints**: Uploads ≤ 10 MB, PDF/DOCX only; single user, no authentication; OpenRouter key never logged/exported; LLM payloads minimized to necessary text (no full-document re-sends when a section suffices); per-run cost cap $0.50 (default, user-adjustable).

**Scale/Scope**: One user, one active profile, dozens of source documents, hundreds of profile entries.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` exists but is an **unfilled template placeholder** — no ratified principles or gates. No constitution violations are possible; the governing constraints are the clarified spec (especially FR-003/FR-005/FR-007/FR-014/FR-029/FR-030–FR-033) and the locked stack. **Post-Phase-1 re-check: unchanged — no gates to violate.**

## Project Structure

### Documentation (this feature)

```text
specs/001-ats-cv-tailoring/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
│   ├── api.md
│   ├── llm-router.md
│   └── parsecv-task.md
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma        # data model (see data-model.md)
└── migrations/

uploads/                 # gitignored; original CV files, content-addressed by sha256

src/
├── app/
│   ├── page.tsx                    # dashboard: profile status, upload entry
│   ├── upload/page.tsx             # upload wizard (file → extract → parse → review draft)
│   ├── profile/page.tsx            # profile editor (sections, provenance badges, autosave)
│   ├── settings/page.tsx           # OpenRouter key, models, cost cap
│   └── api/
│       ├── cv/upload/route.ts              # POST multipart → SourceDocument (extract + detect)
│       ├── cv/[id]/parse/route.ts          # POST → run parseCV → ProfileDraft (slow, isolated)
│       ├── profile/route.ts                # GET profile; PATCH basics/language
│       ├── profile/import/route.ts         # POST draft → profile (replace-parsed / merge)
│       ├── profile/entries/[section]/route.ts        # POST create entry
│       ├── profile/entries/[section]/[id]/route.ts   # PATCH/DELETE entry (autosave target)
│       ├── profile/versions/route.ts       # GET snapshot list; POST restore
│       ├── settings/route.ts               # GET masked / PUT settings
│       ├── settings/validate-key/route.ts  # POST → OpenRouter key check
│       └── validation/claims/route.ts      # POST → basic claim-to-evidence report
├── components/           # shadcn/ui primitives + editor components (BulletEditor, ProvenanceBadge, …)
├── lib/
│   ├── db.ts             # Prisma client singleton
│   ├── files/            # storage.ts (local FS, sha256, size/format guard)
│   ├── parsing/          # pdf.ts (unpdf), docx.ts (mammoth), language.ts (franc + thresholds)
│   ├── dates/            # normalize.ts (EN/FR → YYYY-MM, ambiguity flagging)
│   ├── llm/              # router.ts (callLLM), tasks/parsecv.ts, errors.ts, usage.ts (cap + log)
│   ├── profile/          # repository.ts (getProfile, updateProfileSection), versioning.ts, import.ts
│   ├── validation/       # claims.ts, sourceContainment.ts, schemas.ts (zod domain schemas)
│   └── settings/         # keyStore.ts (env var + encrypted DB), crypto.ts (AES-256-GCM)
└── types/                # zod-inferred domain types

tests/
├── unit/                 # dates, language, containment, schemas, key masking
├── integration/          # route handlers against test DB; LLM router with mocked fetch
└── fixtures/             # cv-en.pdf, cv-fr.pdf, cv-en.docx, cv-fr.docx, scanned.pdf
```

**Structure Decision**: Single Next.js project. App Router route handlers are the API surface (no separate backend service — single-user local-first makes a split pure overhead); `lib/` mirrors the source document's module boundaries (Profile, Ingestion, LLM Router, Fact Guard foundation) so later slices (analysis, generation) extend rather than reorganize.

## Implementation Sequence (guidance for `$speckit-tasks`)

1. **Scaffold**: Next.js + TS strict + Tailwind + shadcn/ui; Prisma + PostgreSQL (docker compose for dev); zod; vitest wiring.
2. **Data model**: Prisma schema + initial migration + repository (CRUD, versioning, snapshots) with integration tests.
3. **Ingestion pipeline**: upload route, unpdf/mammoth extraction, franc language detection, SourceDocument persistence — image-only/oversized/unsupported rejection paths.
4. **LLM router**: key store (env + encrypted setting) with validation endpoint, `callLLM` with structured outputs + zod enforcement + repair retries, usage/cost logging, per-run cap, error taxonomy.
5. **parseCV task**: prompt + output schema, EN/FR date normalization, low-confidence flagging, **source-containment zero-invention check**, ProfileDraft persistence.
6. **Import**: draft → profile with replace-parsed/merge semantics preserving user-entered entries.
7. **Editor UI**: section CRUD, debounced autosave, provenance badges, language correction, low-confidence highlighting.
8. **Basic claim validation**: provenance-coverage report endpoint + minimal UI surface.
9. **Settings UI + fixtures**: key/models/cap screens; full fixture pass (EN, FR, DOCX, scanned, invalid-key) matching quickstart.md scenarios.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — no constitution gates exist (placeholder constitution) and no violations were introduced.
