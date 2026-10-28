# LLM Task Contracts: Slice 2

Both tasks register into the existing router registry (economy tier, structured outputs when the model supports them, prompt-only JSON + zod + ≤2 repair retries otherwise — router behavior unchanged from Slice 1). Payload minimization: only the text each task needs.

## Task: `extractRequirements`

- **Input**: `{ text: string (JD, with paragraph markers), language: "fr" | "en" }`
- **Output schema** (zod):
```ts
{ requirements: Array<{
    text: string            // verbatim requirement phrase from the JD, 1..500 chars
    category: "skill" | "tool" | "years_experience" | "education" | "domain" | "language" | "other"
    importance: "must" | "nice"
    isHardConstraint: boolean
  }> }
```
- **Prompt constraints (binding)**: "Extract only requirements explicitly stated in the text. Do not invent, merge, or infer requirements. Keep requirement text verbatim in the document's language ({language}). `must` vs `nice` follows the JD's own markers (e.g., 'required/exigé/obligatoire' vs 'plus/atout/nice to have'). `isHardConstraint` is true only for required tools, certifications, licenses, or explicit years of experience. Omit anything you cannot ground in the text."

## Task: `semanticProposals`

The deterministic split of the source doc's `generateMatchReport` (R4): the LLM only *proposes*; the engine validates and scores.

- **Input**: `{ language, requirements: Array<{ index: number, text: string }>, profileDigest: Array<{ id: string, type: "skill" | "bullet" | "education" | "certification", text: string }> }`
  - `requirements` = non-hard, unmatched-so-far requirements only (engine pre-filter; hard constraints are excluded by construction — FR-006/FR-007).
  - `profileDigest` = capped (~120 entries, recency-ordered) id+snippet pairs from the pinned profile snapshot (`src/lib/matching/digest.ts`).
- **Output schema**:
```ts
{ proposals: Array<{
    requirementIndex: number
    entryIds: string[]          // must reference digest IDs — validated deterministically
    rationale?: string          // ≤200 chars, display-only
  }> }
```
- **Prompt constraints (binding)**: "You see numbered requirements and a numbered profile digest. Propose matches only where the profile entry genuinely demonstrates the requirement. Cite exact entry IDs. If nothing genuinely matches a requirement, return no proposal for it. Never invent entry IDs or stretch weak associations — a missing proposal is a better answer than a wrong one."
- **Validation (code, engine side)**: proposals with missing/empty/unknown `entryIds` are dropped (`semanticDropped` counter); the LLM's text never enters the report — EvidenceRefs are built from the real entries.
