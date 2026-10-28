# Data Model: Slice 2 — JD Analysis & Deterministic Matching

**Date**: 2026-10-21 · Canonical RequirementMatch/EvidenceRef/MatchReport interfaces: `ProfileForge-Specification.md` §4 (the stored `matchReport` JSONB conforms to that shape plus the slice's `semanticDropped` metric and per-requirement notes). New Prisma models below extend the Slice-1 schema.

## Entity Overview

```text
JobAnalysis 1──* JobRequirement
JobAnalysis *──1 (optional) JobAnalysis (rerunOfId chain)
JobAnalysis.pin → Profile.version (logical, by value)
```

## JobAnalysis

| Field | Type | Rules |
|-------|------|-------|
| id | cuid (PK) | |
| jdText | text | 200..100_000 chars (FR-001; upper bound = refuse, no silent truncation) |
| language | `fr` \| `en` | deterministic detection at create; user-correctable while status ≠ `matched` |
| languageManuallyCorrected | bool | default false |
| status | `created` → `extracted` → `finalized` → `matched` \| `failed` | state machine; `failed` carries `statusError` and allows retry of the failed action |
| statusError | text? | populated on `failed` |
| profileVersion | int? | pinned at match time (parent FR-027); null before first match |
| matchReport | JSONB? | canonical MatchReport (§4 shape + semanticDropped + notices); immutable once written |
| semanticDropped | int | default 0; count of LLM proposals rejected by evidence validation (surfaced as a metric) |
| notice | text? | e.g. "semantic matching unavailable — exact/alias only" (FR-014 degradation) |
| rerunOfId | string? (self-FK) | set when this analysis was created by a re-run |
| createdAt / updatedAt | datetime | |

State transitions: `created → extracted` (extract succeeds), `extracted → finalized` (requirements PUT with user sign-off flag), `finalized → matched` (match run succeeds; pins profileVersion, writes matchReport) or `→ failed` (any LLM/系统 error; retry returns to the prior stable status). Re-run: creates a new analysis in `finalized` (requirements copied), immediately eligible for match.

## JobRequirement

| Field | Type | Rules |
|-------|------|-------|
| id | cuid (PK) | |
| analysisId | FK → JobAnalysis | cascade delete with the analysis |
| text | string | 1..500 chars; JD language; user-editable |
| category | enum | skill, tool, years_experience, education, domain, language, other |
| importance | `must` \| `nice` | |
| isHardConstraint | bool | default false; true for required tools/certs/licenses/explicit years (FR-002) |
| order | int | stable ordering |
| source | `extracted` \| `user` | `user` = added manually during review |
| userConfirmed | bool | default false; set by the confirm endpoint — records a user-confirmed semantic match on a hard constraint (FR-007); persists across re-runs via requirement copy |

## matchReport JSONB (stored shape — canonical §4 + slice extensions)

```ts
{
  overallScore: number                    // 0–100, integer
  scoreBreakdown: {
    hardRequirementsMet: number           // counts, for display
    preferredRequirementsMet: number
    exactMatches: number
    aliasMatches: number
    semanticMatches: number
    hardWeight: number                    // 60 or shifted (transparency)
    preferredWeight: number
    evidenceBonus: number                 // 0–10
  }
  requirements: RequirementMatch[]        // one per finalized requirement, in order
  recommendedKeywords: string[]
  missingKeywords: string[]
  semanticDropped: number                 // invalid proposals dropped (validation metric)
}
// RequirementMatch: { id, text, importance, isHardConstraint, status: strong|partial|gap,
//   matchMethod: exact|approved_alias|semantic|none, evidence: EvidenceRef[], note?,
//   userConfirmed?: true }
// EvidenceRef: { type: bullet|skill|education|certification, id, snippet }
```

## Validation rules (cross-cutting)

- All API payloads zod-validated (jobs schemas in `src/lib/jobs/schemas.ts`); the engine consumes only finalized `JobRequirement` rows and the profile DTO — never raw LLM output.
- Score recomputation (SC-004): `scoreFromMatches(requirements, matches)` is a pure function over the stored report — recomputing must reproduce `overallScore` and `scoreBreakdown` exactly; unit-tested table-driven.
- Immutability: once `status = matched`, `matchReport` is never rewritten (a changed profile or requirements ⇒ re-run ⇒ new analysis row).
- Deterministic layers receive a stable profile snapshot: the match orchestration reads the profile once at match start and passes it through; concurrent edits during a match do not affect the in-flight computation (consistent with Slice 1's job-start snapshot rule).

## Deferred (later slices — do not model)

GeneratedDocument/ValidationReport persistence (Slice 3), benchmark fixtures schema (Slice 4), interview-prep annotations beyond the copyable report.
