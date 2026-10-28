# Implementation Plan: Explicit, Evidence-Backed CV Selection & Rewriting

**Branch**: `005-cv-selection-refinement` | **Date**: 2026-10-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-cv-selection-refinement/spec.md`; inherited constraints from `specs/003-cv-generation/spec.md` + its implemented, reviewed pipeline (`src/lib/generation/**`); verified code facts are cited inline.

**Slice scope**: Make CV content selection explicit and inspectable (an explicit per-section selection cut with a persisted, user-visible selection record — today every ranked item is drafted and only the page budget trims), extend rewriting to role titles (a real content-model extension — titles currently pass through from the snapshot at render time), turn the Professional Summary into a per-JD synthesis with an explicit length bound, and complete the omissions list with selection-ranking reasons. Fact Guard scope extends to titles; FR/EN applies to all rewritten strings.

## Summary

Four changes on the existing pipeline. (1) **Selection cut**: after deterministic ranking, the plan stage keeps the top entries per section under budget-scaled caps (must-include restored items always in) and seeds every unselected entry into the omissions list with reason `selection`; a new `selection` JSONB on the document version persists the included entries' basis (rank, score, evidence refs, recency) for the inspectable Selection View. (2) **Title rewriting**: the content model gains a per-entry rewritten `title` claim (`expTitle.{id}`, provenance = the entry), the plan emits a title item per experience entry (verbatim fallback on skip), the renderers draw the content title, the extraction gate checks the *rendered* title, and the Fact Guard validates title claims (numeric + semantic) exactly like bullets. (3) **Summary synthesis**: the generation settings gain `summaryMaxWords` (default 60); the draft prompt receives the MatchReport's top must-have requirements explicitly alongside the strongest evidence sources, so the summary is a per-JD synthesis (payload-difference tests + live spot-check). (4) **Omissions completeness**: reasons distinguish `page_budget` / `selection` / `unwritten`; restore semantics unchanged. One additive Prisma migration (`GeneratedDocumentVersion.selection Json?`), no new dependencies.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 20, Next.js 16 App Router — the existing stack, unchanged.

**Primary Dependencies**: No new packages. Reused as-is: the `callLLM` task registry (premium `generateTailoredCV` input schema extended additively), zod 4, the Fact Guard layers, `checkContainment`/`unpdf` extraction gate, pdf-lib renderers, the error envelope.

**Storage**: PostgreSQL via Prisma 7 — one additive migration: `GeneratedDocumentVersion.selection Json?` (the persisted selection record; nullable — versions from before this feature render the view as "not recorded"). Content/report/artifacts JSONB shapes extend per data-model.md.

**Testing**: vitest (unit + integration, mocked `callLLM`, direct handler invocation) and the existing Playwright E2E suite (004) — selection/title assertions extend the `01`/`02` spec patterns; the two-JD summary-difference criterion is verified at payload level plus a documented live spot-check (research R5).

**Target Platform**: local-first single-user Next.js app on localhost — unchanged.

**Project Type**: Extends the existing application (Slices 1–3 implemented; 004 E2E suite in place).

**Performance Goals**: selection cut + selection record built within the existing plan stage budget (no added LLM calls); generation end-to-end still < 90 s typical; document GET with the selection view < 200 ms.

**Constraints**: no new LLM calls (rewriting reuses the single premium call with an extended output schema); zero-invention invariants and the fail-closed Fact Guard hold for titles; SC-002 determinism (same snapshot + report → same selection) must survive the new cut; parent cost cap and error taxonomy unchanged; one migration, additive only.

**Scale/Scope**: ~5 lib files extended (`plan.ts`, `schemas.ts`, `draft.ts`, `factguard.ts`, `pipeline.ts` + renderers/verify), 1 migration, 1 route payload extension, 1 new UI section, ~10 unit + ~6 integration test updates/additions, E2E assertions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` remains an unfilled template (verified 2026-10-25) — no ratified gates exist. Governing constraints: the 005 spec, the inherited 003 decisions, and the product reference §2. Pre-Phase-0: nothing to violate. **Post-Phase-1 re-check: unchanged — the design stays inside the inherited invariants (deterministic-first, keyed rewriting, provenance-by-construction, fail-closed gate); the one content-model change (title claims) preserves all five non-negotiable invariants verified by the 003 review.**

## Project Structure

### Documentation (this feature)

```text
specs/005-cv-selection-refinement/
├── plan.md                      # This file
├── research.md                  # Phase 0 — decisions R1–R7
├── data-model.md                # Phase 1 — content-model extension, selection record, settings
├── quickstart.md                # Phase 1 — validation scenarios
├── contracts/
│   ├── selection-rewriting.md   # Selection cut policy, title claims, summary synthesis, omissions reasons
│   └── api-additions.md         # Document-route `selection` field; settings `summaryMaxWords`
└── tasks.md                     # $speckit-tasks output (NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
prisma/schema.prisma            # + GeneratedDocumentVersion.selection Json? (additive migration)
prisma/migrations/…_selection/  # generated migration

src/lib/generation/
├── schemas.ts                  # + expTitle claim id + title claim content shape + SelectionRecord + summaryMaxWords
├── plan.ts                     # + selection cut (per-section caps), title plan items, summaryRequirements,
│                               #   selection-record building, selection omissions seeding
├── draft.ts                    # + keyed merge for title items, summaryMaxWords in payload, omissions seeding
├── factguard.ts                # + title claims in collection + deterministic/semantic layers
├── repository.ts               # + selection passthrough on appendVersion/upsertJobVersion/getVersionForJob
├── pipeline.ts                 # + selection record into StageContext/persist
├── fit.ts                      # unchanged mechanics; omission reasons already an open string
├── verify.ts                   # + level-1 structural title check reads the RENDERED title
└── render/{cv,docx}.ts         # draw the content title (fallback: snapshot title)

src/lib/llm/tasks/generatetailoredcv.ts   # + title items in output schema, summaryRequirements, summaryMaxWords

src/app/api/generations/[id]/document/route.ts  # + selection field in the payload

src/components/generation/
├── GenerationPanel.tsx         # + summaryMaxWords setting; selection summary line
└── SelectionView.tsx           # NEW — per-entry selection basis + rank + evidence links

tests/unit/generation-{plan,draft,factguard,verify}.test.ts   # extended: cut, titles, title claims, gate title
tests/integration/generations-api.test.ts                     # extended: selection record, title persistence, omissions completeness
tests/e2e/01-seed-and-display.spec.ts, 02-experience-crud.spec.ts  # extended: selection view + rewritten title assertions
```

**Structure Decision**: Everything extends the existing slice-3 module layout; the only new file is the `SelectionView` component, and the only new persistence is the nullable `selection` JSONB. No new routes (the document route payload gains a field), no new LLM tasks (the existing premium task's schemas extend additively).

## Implementation Sequence (guidance for $speckit-tasks)

1. **Contract & schema foundations**: `schemas.ts` — `expTitle.{id}` claim ids (`parseClaimId` extension), title claim content shape, `SelectionRecord`/`SelectionBasis` types, `summaryMaxWords` in settings (default 60, bounds in data-model.md); Prisma migration for `selection Json?`; repository passthroughs.
2. **Selection cut + record**: `plan.ts` — after ranking, apply per-section caps (budget-scaled constants in contracts/selection-rewriting.md; must-include always kept), build the selection record (rank/score/evidence/recency basis per included entry), seed selection omissions; unit tests for cut determinism, cap math, restore interplay.
3. **Title rewriting**: title plan items → task output schema (`title` per entry, keyed) → keyed merge → content shape → renderers (content title, fallback verbatim + `VERBATIM_FALLBACK`) → extraction gate reads the rendered title → Fact Guard title claims (deterministic + semantic; claim routes work via `parseClaimId`); removal semantics: a title claim DELETE falls back to the verbatim snapshot title (an entry always has a title — research R2).
4. **Summary synthesis**: settings plumbing (`summaryMaxWords` end-to-end: input → settings → payload → prompt), `summaryRequirements` (top must-have texts) in the task input/prompt; payload-difference tests for SC-005's mechanism.
5. **API + UI**: document route `selection` field; `SelectionView` component (basis, rank, evidence links reusing the existing drill-down evidence map); `summaryMaxWords` in the settings form.
6. **E2E + polish**: extend 004's specs (selection view visible, rewritten title ≠ verbatim where served, omissions completeness on a rich profile); full-suite regression; quickstart walk-through.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — no constitution gates exist (placeholder constitution). The single schema migration is additive and nullable; the content-model change (title claims) was verified against all five non-negotiable invariants in the 005 research (R2).
