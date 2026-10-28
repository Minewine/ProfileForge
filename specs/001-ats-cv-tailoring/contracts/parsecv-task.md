# parseCV Task Contract

LLM task converting extracted CV text into a structured ProfileDraft. Implements `parseCV` from `ProfileForge-Specification.md` §6 for French and English inputs.

## Input (to the LLM)

- `text`: extracted document text with page/paragraph markers (`<<<PAGE 3>>>` / `¶12`), enabling provenance locators.
- `language`: detected language (`fr` | `en`) — also passed into the prompt ("parse in this language; keep proper nouns verbatim").
- No file bytes, no settings, no key material (payload minimization).

## Output schema (zod, abbreviated)

```ts
ProfileDraft = {
  basics: { name, headline?, summary?, location?, email?, phone?, links?[] },
  experience: { company, title, location?, startDateRaw?, endDateRaw?,
                bullets: { text, page?, paragraphIndex? }[], skillsUsed: string[] }[],
  education: { institution, degree?, field?, startDateRaw?, endDateRaw?, page? }[],
  skills: { name, category?, page? }[],
  languages: { name, proficiency? }[],
  projects: { name, description?, link?, startDateRaw?, endDateRaw?, page? }[],
  certifications: { title, issuer?, issueDateRaw?, page? }[]
}
```

Every field the LLM cannot ground in the source text is omitted (never guessed). Raw date strings are returned as-is (`*Raw`); conversion to `YYYY-MM` is deterministic code, not LLM output.

## Prompt constraints (binding)

- "Use only facts present in the provided text. Do not invent, infer, or complete employers, titles, dates, skills, tools, metrics, degrees, or achievements. When unsure, omit the field."
- "Reproduce bullet text faithfully — do not polish, merge, or rewrite."
- "Return `page`/`paragraphIndex` locators for every item you extract."
- French and English handled identically; FR month names, "depuis", "présent/aujourd'hui" pass through as raw strings.

## Deterministic post-pass (code, after LLM returns)

1. **Date normalization** (R9): every `*Raw` → `YYYY-MM` | `present` | `null + low-confidence flag`. Ambiguity is never resolved by guessing.
2. **Source-containment check** (R8): each bullet and material field must achieve ≥95% word-level containment in the normalized extracted text; failures get `containmentOk: false` + low-confidence flag (and require `user_confirmed` before counting as clean evidence).
3. **Confidence annotation**: fields the LLM omitted from sections it clearly found (e.g., experience without dates) are flagged low-confidence for review (FR-003).

## Slice acceptance (testable)

- EN + FR fixture CVs → drafts with correct sections, provenance locators, normalized dates.
- A fixture with unparseable dates yields null + flags, never a guessed date.
- A doctored LLM response containing an invented bullet is caught by containment and flagged/dropped.
- Full pipeline cost for one parse run stays under the economy-tier fraction of the $0.50 cap (logged via LlmUsageLog).
