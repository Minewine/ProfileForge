# Matching Engine Contract (deterministic core)

Implementation: `src/lib/matching/engine.ts` (layers + validation + statuses) and `src/lib/matching/score.ts` (pure scoring). Everything here is pure code — **no LLM calls** — and table-driven unit-tested.

## Inputs

- `requirements: JobRequirement[]` — the finalized, user-corrected list.
- `profile: ProfileDto` — the pinned snapshot (Slice-1 DTO, incl. bullets and `skillsUsed`).
- `semanticProposals: Proposal[] | null` — validated-or-null output of the LLM task (see llm-tasks.md); `null` ⇒ degraded mode.

## Layer 1 — exact (credit 1.0)

Normalized (case-, accent-insensitive — `src/lib/text/normalize.ts`) **equality** between a requirement's text and a structured profile term:
- `Skill.name`, `Certification.title`, `Experience.skillsUsed[]`, `LanguageSkill.name` (for `language`-category requirements).
Free-text bullets are never exact candidates (R2). A structured term also matches exactly when it appears as a **whole phrase inside the requirement text** ("exposure to project management" ⊃ "project management"; longest term wins, word-boundary enforced) — qualifiers in requirement phrasing must not hide a real term match. All structured hits become EvidenceRefs; the first skill/cert hit sets the method.

## Layer 2 — approved alias (credit 0.9)

The requirement's normalized form and a structured profile term match if they belong to the same alias group of:
1. `BUILTIN_ALIASES` (versioned seed in `src/lib/matching/aliases.ts`, bilingual groups, `ALIAS_LIST_VERSION`), or
2. a profile Skill's user-approved `aliases[]` (Skill.aliases ↔ Skill.name).
Nothing else is an alias (parent FR-007) — no stemming, no edit distance, no synonyms.

## Layer 3 — semantic (credit 0.7, non-hard only, evidence-validated)

- Runs only for requirements with `isHardConstraint = false` that had no exact/alias match.
- LLM proposals (`semanticProposals` task) reference profile entry IDs; the engine:
  - drops proposals with missing/empty/nonexistent `entryIds` → counted in `semanticDropped` (SC-005);
  - builds EvidenceRefs **server-side** from the referenced entries (LLM never writes evidence text);
  - assigns `matchMethod: "semantic"`, status `strong`.
- Hard constraints are never eligible (FR-007); user confirmation is the only path for semantic-on-hard, handled by the confirm endpoint (evidence-gated).

## Statuses (deterministic — R3)

| Status | Condition | Credit |
|--------|-----------|--------|
| strong | exact or alias match **with usage evidence** (skill appears in some experience/project bullet or `skillsUsed`), or credential/education/language category matched, or valid semantic proposal | by method: 1.0 / 0.9 / 0.7 |
| partial | exact/alias **term match without usage evidence** (skill/tool categories only) | 0.5 |
| gap | no match in any eligible layer | 0 |

Years-of-experience nuances surface as `note` text on the match (e.g., "requires 5y; profile shows ~3y in matched roles") — computed from normalized dates, never changing status by itself.

## Score (pure, verbatim from the parent's clarified formula)

```
hardBucket      = 60 × (Σ credit(hard)   / count(hard))
preferredBucket = 30 × (Σ credit(nice)  / count(nice))
evidenceBonus   = 10 × (matched reqs with ≥1 experience/project bullet EvidenceRef / matched reqs)
overallScore    = round(hardBucket + preferredBucket + evidenceBonus)   // 0–100
```

- Semantic credit never applies to hard constraints.
- Empty bucket ⇒ its weight shifts to the other (0 hard ⇒ preferred worth 90; 0 preferred ⇒ hard worth 90; both empty ⇒ score = evidenceBonus only). `scoreBreakdown` records the effective weights.
- `recommendedKeywords` = matched requirement terms (JD language) prioritized must>nice; `missingKeywords` = gap/partial requirement terms, same ordering.
- **SC-004**: `scoreFromMatches(storedRequirements, storedMatches)` recomputes `overallScore` + `scoreBreakdown` identically — enforced by unit tests recomputing from frozen fixtures.

## Output

The engine returns the canonical MatchReport (§4 shape + semanticDropped + notices) — see data-model.md for the stored JSONB shape. The orchestration route persists it immutably and pins the profile version.
