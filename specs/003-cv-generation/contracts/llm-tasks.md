# LLM Task Contracts — Generation & Fact Guard

All three tasks register on the existing `callLLM` registry (`src/lib/llm/router.ts`) with zod `outputSchema` (structured outputs where the model supports them, prompt-only JSON otherwise, ≤2 schema-repair retries — existing router behavior). Zero-invention prompt constraint (spec §6) is binding for all three: *"Use only facts present in the provided profile or explicitly confirmed by the user. Link every material claim to evidence. Do not invent metrics, tools, employers, or achievements."*

Shared payload-minimization rule: inputs carry only the pinned-snapshot entries selected by the deterministic plan (never the whole profile) plus the MatchReport digest fields each task needs (parent FR-009/FR-019; cost cap per `runId`).

## Task: generateTailoredCV

- **Tier**: premium. **Input**: `{ outputLanguage, notes?, plan: [{key, kind, sourceText[], entryMeta {title, company, dates}}], skills (deterministic, passthrough only), summarySources[], jdDigest {role?, keywords[]}, pageBudget }`.
- **Output**:

```ts
{
  summary: string;                       // output-language, evidence-aware, ≤ 60 words
  items: {
    key: string;                         // MUST be a plan key; unkeyed items are dropped (R7)
    text: string;                        // rephrased/tightened/translated source text
    rationale?: string;                  // ≤ 140 chars, why this phrasing serves the JD
  }[];
  uncertainTranslations?: { key: string; note: string }[];   // → UNCERTAIN_TRANSLATION warnings
}
```

- **Prompt constraints (binding)**: write every narrative string in `outputLanguage`; preserve employer/institution/certification names verbatim; copy every number, date, duration, and metric exactly as in `sourceText` — never round, convert, or estimate; prefer exact JD terminology for hard skills/tools when the plan text supports it; action-oriented phrasing only where the source supports it; do not add items, merge items, or invent content for missing keys.
- **Validation (engine side)**: items keyed to unknown keys are dropped; plan keys absent from the response fall back to verbatim `sourceText` (source language) and raise a warning flag; numeric identity re-checked deterministically by the Fact Guard regardless of model claims.

## Task: generateCoverLetter

- **Tier**: premium. **Input**: `{ outputLanguage, tone, notes?, paragraphs plan: [{key, evidenceText[], angle: "motivation"|"fit"|"achievement"}], cvBulletTexts[] (current CV version — avoid repeating), jdDigest {role?, company?, topRequirements[]}, maxWords: 320 }`.
- **Output**: `{ paragraphs: { key: string; text: string }[]; uncertainTranslations?: { key; note }[] }` — 3–5 paragraphs, ≤ 320 words total, each keyed to a plan angle with its evidence.
- **Prompt constraints (binding)**: same language/verbatim-proper-noun/numeric rules as above; add context and motivation connected to the JD's requirements; **do not reuse or lightly rephrase any string from `cvBulletTexts`**; no achievements/metrics absent from `evidenceText`.
- **Validation (engine side)**: complementarity check — each rendered paragraph vs every CV bullet/summary under `checkContainment`; ≥0.95 containment ⇒ `LETTER_DUPLICATES_CV` blocker (SC-008); unkeyed paragraphs dropped; missing keys → that angle omitted with an omission entry.

## Task: factGuard

- **Tier**: economy. **Input**: `{ outputLanguage, claims: [{ claimId, text, evidenceText[] }] }` — claims are exactly the drafted content blocks with their cited evidence texts (already resolved by the deterministic layer).
- **Output**:

```ts
{
  verdicts: {
    claimId: string;
    verdict: "supported" | "drifted" | "unsupported";
    note?: string;                        // ≤ 140 chars, what changed / what's missing
  }[];
}
```

- **Prompt constraints (binding)**: judge only meaning preservation between `text` and `evidenceText` — rephrasing, tightening, translation, and reordering are `supported`; changed scope, inflated impact, weakened hedges, or added/changed facts are `drifted` (or `unsupported` when nothing in the evidence supports the claim); ignore style and tone; every claimId in the input must appear exactly once in the output.
- **Validation (engine side)**: verdicts for unknown claimIds dropped; missing claimIds treated as `drifted` with note `no-verdict` (conservative); verdict mapping — `drifted`/`unsupported` ⇒ `MEANING_DRIFT`/`UNSUPPORTED_CLAIM` blockers; task failure ⇒ `layersRun.semantic = false` ⇒ download blocked `FACTGUARD_UNAVAILABLE` (fail-closed, FR-010) while the job still succeeds.
