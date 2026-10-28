# Data Model — Explicit, Evidence-Backed CV Selection & Rewriting

Extends the Slice-3 data model (`specs/003-cv-generation/data-model.md`); canonical authority remains `ProfileForge-Specification.md` §4. One additive Prisma migration. Everything not listed here is unchanged.

## Content-model extension (stored in `GeneratedDocumentVersion.content` JSONB)

```ts
// GeneratedCVContent.experience[] entries gain an optional rewritten title:
type ExperienceContentEntry = {
  id: string;               // pinned-snapshot experience id (unchanged)
  title?: {                 // NEW — absent in pre-feature versions
    claimId: string;        // `expTitle.{experienceId}` (new claim-id namespace)
    text: string;           // rewritten in the output language
    sourceTitle: string;    // verbatim snapshot title (inspectability + fallback)
  };
  bullets: { claimId: string; text: string; sourceBulletIds: string[]; rationale?: string }[]; // unchanged
};

// GeneratedCVContentSchema: `title` is optional (backward compatible);
// the claim-id scheme gains expTitle.{experienceId} (parseClaimId extended).
```

## New persisted record (`GeneratedDocumentVersion.selection Json?`, additive migration)

```ts
type SelectionRecord = {
  included: Array<{
    entryId: string;          // pinned-snapshot entry id
    kind: "experience" | "project" | "education" | "certification";
    rank: number;             // 1-based within its section (deterministic order)
    score: number;            // the plan's unit score
    basis: {
      evidenceRefs: EvidenceRef[];  // MatchReport citations resolving into the snapshot
      methodCredits: string[];      // distinct match methods among citations (exact / approved_alias / semantic)
      recency: number;              // the plan's recency component (0..1)
    };
  }>;
  generatedAt: string;        // ISO timestamp of the plan that produced it
};
// Excluded entries are NOT duplicated here — they live in content.omissions
// with reason "selection" (R1/R6).
```

## Settings extension (`GenerationSettings`, frozen at job creation)

```ts
type GenerationSettings = {
  outputLanguage: "fr" | "en";    // unchanged
  pageBudget: number;             // unchanged (1..3, default 2)
  tone: Tone;                     // unchanged (letters)
  notes?: string;                 // unchanged (≤ 2000 chars)
  summaryMaxWords: number;        // NEW — default 60, bounds 30..120, surfaced in the settings form
};
```

## Omission reason vocabulary (extended, same entity)

```ts
type Omission = {
  type: string;    // experience | experience_bullet | project | ... | skill | letter_paragraph
  id: string;
  reason: "page_budget" | "selection" | "unwritten";  // extended from an open string to these three
  restoredMustInclude?: boolean;  // state machine unchanged (omitted → restored → consumed)
};
// "selection" = not selected — stronger evidence chosen (whole entries only, R1)
// "page_budget" = selected/drafted but demoted by the fit loop (unchanged)
// "unwritten" = letter angle the model skipped (unchanged, letters)
```

## LLM task I/O extension (`generateTailoredCV`, additive)

```ts
// Input additions:
type GenerateTailoredCVInput = {
  // ...existing fields...
  summaryRequirements: string[];  // top must-have requirement texts (≤ 5, may be empty)
  summaryMaxWords: number;        // 30..120
};
// Output additions (both optional for backward compatibility with old fixtures):
type GenerateTailoredCVOutput = {
  // ...existing fields...
  items: Array<{
    key: string; text: string; rationale?: string;
    // plan keys now include expTitle.{id} items — no shape change per item
  }>;
};
```

## State machines

- Omission states: unchanged (`omitted → restoredMustInclude → consumed`); a restored `selection` omission's entry re-enters the plan as must-include and, if later demoted by fit, re-appears with reason `page_budget` (R6).
- Claim resolution: unchanged; `expTitle.{id}` claims accept edit (replaced text) / confirm (fingerprint); DELETE falls back to the verbatim snapshot title (research R2 — an entry always has a title).

## Validation rules (cross-cutting additions)

- Every `expTitle.*` claim's provenance resolves to its experience entry in the pinned snapshot; the Fact Guard's numeric + semantic layers treat titles exactly like bullets.
- The extraction gate's level-1 `experience:{id}:title` structural element compares the RENDERED title (content title when present, else snapshot title).
- Selection caps and their budget scaling are documented constants (contracts/selection-rewriting.md); determinism (SC-002) is preserved — caps apply to a deterministic order with deterministic tie-breaking.
- `summaryMaxWords` ∈ 30..120; the task input schema enforces it.
- Selection records are immutable once persisted (like content); regeneration writes a new version.

## Deferred (do not model)

- Any ranking-weight recalibration (003 follow-up), the Slice-4 benchmark persistence, Gap Bridge UI, cover-letter selection records (letters have no selection cut — all angles are drafted).
