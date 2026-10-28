# Research — Explicit, Evidence-Backed CV Selection & Rewriting

Phase 0 decisions for feature 005. Format follows `specs/003-cv-generation/research.md`. Code facts were verified against the working tree (post-003-review state) during planning.

---

## R1: The selection cut — an explicit per-section cap applied after ranking

**Decision**: After the deterministic ranking (unchanged weights), the plan stage applies per-section caps and drafts only the top entries: experience **4 entries**, projects **2**, education **3**, certifications **3** at the default budget of 2 — scaled by page budget (1 → floor(cap/2), min 1; 3 → cap + 1), constants documented in `contracts/selection-rewriting.md` as tunable v1 values. Restored must-include items are always kept (and do not consume the cap — they are exempt, so a restore never pushes out a higher-ranked selected entry… unless the fit loop later demotes it, which is the parent's page-budget path). Unselected entries are seeded into `content.omissions` with reason `selection` at draft time. Whole entries only (bullet-level cuts remain the fit loop's `page_budget` concern).

**Rationale**: Today the plan emits EVERY ranked item and only the fit loop trims — "selection" is implicit. The spec's FR-001/FR-002 require an explicit, inspectable selection, and the caps make "the most relevant entries were chosen" true by construction while remaining deterministic (SC-002). Budget-scaled caps keep the fit loop's job small (demote a few bullets, not whole pages).

**Alternatives considered**: Score threshold (arbitrary to tune, unstable across profiles); cap only experience (incomplete — the spec demands selection-accounting for every section); no caps, derive "selected" retroactively from what fit kept (would make selection a post-hoc label of truncation — exactly what the spec rejects).

---

## R2: Title rewriting — a content-model extension, claims by construction

**Decision**: `GeneratedCVContent` experience entries gain `title: { claimId: "expTitle.{experienceId}", text, sourceTitle }`. The plan emits one title plan item per selected experience entry (sourceText = the snapshot title; provenance = the entry id); the premium task's output items carry those keys like bullets (one rewrite instruction set covering both); the keyed merge sets `entry.title` (fallback: verbatim snapshot title + `VERBATIM_FALLBACK` warning — an entry always HAS a title, so a title claim's DELETE falls back to verbatim rather than removing it). `parseClaimId` learns `expTitle.{id}`; claim routes work unchanged. Renderers draw `content.title.text` (company still from the snapshot); the extraction gate's level-1 `experience:{id}:title` structural check compares against the RENDERED title (content title when present, else snapshot). The Fact Guard's `collectCVClaims` includes title claims — deterministic numeric check and semantic meaning-preservation apply (a title rarely carries numbers, but "Led 5-engineer team" in a title must match evidence).

**Rationale**: Titles currently pass through from the snapshot at render time (verified: the content schema has no title field; `renderCV` draws `meta.title — meta.company`). Making titles claims keeps the strongest invariant — provenance attached by construction, the model can only rewrite keyed items — while adding the user-requested title tailoring. The gate nuance matters: checking the snapshot title would be checking a string the PDF no longer contains once titles are rewritten.

**Alternatives considered**: Rewrite titles only in the prompt without a content field (untestable, not inspectable, provenance lost); render-time rewriting (breaks the keyed-merge invariant that provenance never passes through the model).

---

## R3: Summary synthesis — requirements become first-class prompt inputs + a length-bound setting

**Decision**: `GenerationSettings` gains `summaryMaxWords` (default 60, bounds 30–120; surfaced in the settings form). The `generateTailoredCV` input gains `summaryRequirements: string[]` (top must-have requirement texts, ≤5, from the finalized MatchReport — empty when none) alongside the existing `summarySources`; the system prompt's summary instruction is rewritten to: synthesize a summary that explicitly connects the candidate's strongest evidence to the listed requirement areas, in `summaryMaxWords` words or fewer, no generic profile blurb. The merge is unchanged (summary + `summaryProvenance` from the plan).

**Rationale**: Today the prompt hardcodes "at most 60 words" and gives the model only evidence sources + recommended keywords — the JD's must-have priorities never reach the summary step explicitly (verified in the task source). SC-005 (two JDs → two different summaries) needs the requirements as inputs; the length bound makes an implicit prompt line a user-visible setting per the spec.

**Alternatives considered**: Separate summary LLM call (extra premium cost for marginal gain — one call already produces keyed items and summary); derive requirements client-side only (the task input schema is the right contract point).

---

## R4: Selection record — persisted, derived-from-plan, nullable

**Decision**: New nullable `GeneratedDocumentVersion.selection Json?` (additive migration). Shape: `{ included: [{ entryId, kind, rank, score, basis: { evidenceRefs: EvidenceRef[], methodCredits: string[], recency: number } }], generatedAt: ISO }` — built in the plan stage from data it already computes, persisted with the version via `appendVersion`/`upsertJobVersion`, returned by the document route, rendered by the new `SelectionView`. Excluded entries live in `content.omissions` (R1) — no duplication. Versions without a selection record (pre-feature) render "not recorded".

**Rationale**: The selection basis (scores, method credits, recency, rank) exists only in the in-memory plan today and is NOT recoverable from persisted content — the spec's inspectability requirement needs it persisted. Nullable keeps the migration additive and old versions readable.

**Alternatives considered**: Recompute the plan on read (nondeterministic across code changes — the persisted version's view must reflect what THAT generation actually chose); persist only ranks (basis without evidence refs fails the drill-down requirement).

---

## R5: Verification strategy for the LLM-behavior criteria

**Decision**: SC-002 (identical selection) and SC-007 (omissions completeness) are fully unit/integration-testable — pure plan functions plus persisted records. SC-005 (two JDs → different summaries) is verified in two layers: (a) mocked tests prove the MECHANISM — different MatchReports produce different `summaryRequirements`/source orderings in the task payload (payload-difference assertions), and the merge passes the model's summary through verbatim; (b) the OUTPUT-difference half is a live-model criterion, validated once against the real OpenRouter key and recorded in the quickstart (same provisional approach the parent spec uses for its LLM-behavior criteria until the Slice-4 benchmark).

**Rationale**: Mocked `callLLM` is the suite's deliberate design (no key in CI); pretending to assert model-output differences under a mock would be a tautology. Splitting mechanism-vs-output keeps every automated assertion honest.

---

## R6: Fit-loop and restore interplay with selection omissions

**Decision**: `content.omissions` is seeded with `selection` omissions at draft time (before fit). The fit loop appends `page_budget` omissions as today. A restored selection omission makes the entry must-include in the plan (existing mechanism, matched by entry id) — so it is drafted and no longer carries a selection omission; if it then cannot fit, the fit loop demotes it with `page_budget` — a correct, visible reason change. The must-include pre-check is unchanged. `PAGE_BUDGET_CONFLICT` behavior unchanged.

**Rationale**: One omission list, two reason vocabularies, exactly one active reason per excluded entry at any time. The pre-existing P2-6 note from the 003 review (pre-check timing) is explicitly OUT of scope here — it is recorded as a 003 follow-up and does not interact with this design.

---

## R7: Backward compatibility and scope fences

**Decision**: The migration is additive/nullable; old versions render the Selection View as "not recorded" and their content (no title field) is handled by optional-title schemas (`title?` on experience entries) so claim-resolution routes keep working on old versions. The extended `generateTailoredCV` output schema makes the new title/uncertainty fields optional so old mocked fixtures and in-flight jobs don't break mid-deploy. Out of scope, restated: cover-letter pipeline (its paragraphs already follow the evidence rules), matching changes, new templates, languages beyond FR/EN, any Fact Guard relaxation.

**Rationale**: The 004 E2E suite and the 003 test suite must stay green through this feature; optional-field extensions and the nullable record are the cheapest way to guarantee that.
