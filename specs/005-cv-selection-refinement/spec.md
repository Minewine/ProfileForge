# Feature Specification: ProfileForge — Explicit, Evidence-Backed CV Selection & Rewriting

**Feature Branch**: `005-cv-selection-refinement`

**Created**: 2026-10-25

**Status**: Draft

**Input**: User description: "Refine CV generation so that content selection and rewriting are explicit and evidence-backed. Required behavior: When generating a CV from a MatchReport, the system must: 1. Select the most relevant Experience entries and Roles from the profile (based on match evidence, recency, and strength). 2. Tweak/rephrase the selected bullets and titles for the target job (emphasize, shorten, reorder) while preserving factual integrity. 3. Attach sourceBulletIds / provenance to every rewritten bullet. 4. Generate a custom Professional Summary / About Me section that synthesizes the most important points from: the job’s key requirements + the strongest matching evidence in the profile. 5. Include an inspectable omissions list for any profile content that was left out. Fact Guard still blocks export if any material claim cannot be traced to the profile. Output language (FR/EN) is user-selectable and applied to both the summary and the rewritten bullets. Update the Slice 3 spec (or create a focused follow-up) so this selection + rewriting + summary behavior is a first-class, testable requirement."

**Parent specification**: This is a focused follow-up to [specs/003-cv-generation/spec.md](../003-cv-generation/spec.md) — it refines that spec's US1 (evidence-aware generation) and US4 (output language) into sharper, independently testable requirements, and builds on the implemented, reviewed Slice-3 pipeline (matched JobAnalysis in → pinned profile snapshot, deterministic selection plan, keyed LLM rewriting, two-layer Fact Guard, verified ATS export). It does NOT reopen 003's settled decisions: zero-invention with claim-level provenance, the Fact Guard export block (any material claim that cannot be traced to the profile prevents download), page-budget fitting, and the single template all remain binding — this refinement only tightens and extends them. What this feature changes is scope and testability of four behaviors: (a) selection transparency, (b) rewriting of role titles in addition to bullets, (c) an explicit summary-synthesis contract, and (d) omissions completeness. Everything else in 003 is inherited unchanged.

## Clarifications

### Session 2026-10-25

- Q: Does "select the most relevant Experience entries and Roles" change what is selected today, or formalize it? → A: Formalize first, extend second: the deterministic ranking (match evidence, recency, strength, impact) stays the contract; the new parts are that role titles are first-class rewrite targets alongside bullets, and that the selection outcome (which entries were chosen and why) must be inspectable by the user, not only internal.
- Q: Must the rewritten title stay truthful to the stored role? → A: Yes — titles are rephrased under the same zero-invention rule as bullets: emphasize/shorten/align terminology to the JD, but never invent a title the profile does not support; the Fact Guard's numeric/provenance rules apply unchanged, and the title's provenance remains the profile entry.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — See Which Content Was Selected and Why (Priority: P1)

When a CV is generated from a matched analysis, the user can inspect, for every experience entry and role that appears in the draft, why it was chosen: the match evidence that connects it to the job, its recency, and its relative standing against the entries that were left out. The selection is deterministic — the same profile snapshot and MatchReport always produce the same selection — and the user can trace any included or omitted entry back to its profile source.

**Why this priority**: "Explicit and evidence-backed" is the point of this feature: without visible selection reasoning, tailoring looks like an opaque rewrite. This story is also the prerequisite for trusting the rewriting (US2) and the summary (US3).

**Independent Test**: Generate from a fixed snapshot + MatchReport; inspect the selection view; verify each included entry shows its evidence/recency basis, omitted entries appear in the omissions list with reasons, and regenerating on identical inputs yields an identical selection.

**Acceptance Scenarios**:

1. **Given** a matched analysis and a profile with more relevant entries than fit, **When** the CV is generated, **Then** every included experience entry's drill-down shows the match evidence (or keyword-overlap/recency basis when no requirement cites it directly) that justified its selection.
2. **Given** the same snapshot and MatchReport, **When** generation runs twice, **Then** the selection (entries, order, roles) is identical.
3. **Given** an entry left out of the draft, **When** the user inspects the omissions list, **Then** the entry appears with a reason (page budget or selection ranking) and is restorable per the parent spec.
4. **Given** an entry whose match evidence was pruned as stale (profile edited since the match), **When** the selection runs, **Then** the entry is ranked on its remaining basis only — and the stale-analysis notice from the parent spec still applies.

---

### User Story 2 — Bullets and Role Titles Are Rewritten for the Target Job (Priority: P1)

The selected bullets AND the role titles of the selected entries are rephrased for the target job: emphasized toward the JD's terminology, shortened where the source is long, and reordered within an entry by relevance. Rewriting is rephrasing only — every rewritten bullet and title keeps its provenance link to the profile source, numbers/dates/metrics are copied exactly, and employer/institution names stay verbatim. A rewritten title must remain recognizable as the stored role (e.g., "Senior Platform Engineer" may become "Platform Engineer — Kubernetes/SRE focus" only if the profile supports it; it may never become "Engineering Manager"). Rewrites are per-item and inspectable: the user can compare each rewritten string against its source.

**Why this priority**: This is the "tweak/rephrase" core of the request, extended to titles — which today pass through untouched. It delivers the visible tailoring value while the zero-invention machinery guarantees honesty.

**Independent Test**: From a seeded profile + MatchReport, generate in English and in French; verify every included bullet and title differs from verbatim source where the rewrite serves the JD, carries its `sourceBulletIds`/provenance, copies numbers exactly, stays in the output language (proper nouns verbatim), and passes the Fact Guard unchanged.

**Acceptance Scenarios**:

1. **Given** a selected entry, **When** the draft is produced, **Then** its bullets are rewritten in the output language with JD-relevant emphasis and any reordering justified by relevance — and each bullet carries its source provenance.
2. **Given** a selected role title, **When** the draft is produced, **Then** the title is rewritten in the output language for the target job without inventing seniority, employers, or credentials absent from the profile.
3. **Given** a number, date, duration, or metric in the source, **When** any bullet or title is rewritten (including translated output), **Then** the value is identical to the profile — the Fact Guard's deterministic numeric check applies to titles as well as bullets.
4. **Given** the Fact Guard flags a rewritten bullet or title, **When** the user resolves it, **Then** resolution works exactly as in the parent spec (edit/remove/confirm; blockers gate download).
5. **Given** a title whose faithful translation the model cannot produce, **When** the draft is assembled, **Then** the uncertainty is surfaced as a warning for user confirmation — never silently improvised.

---

### User Story 3 — A Custom Professional Summary Synthesizing the Job and the Evidence (Priority: P1)

The generated CV opens with a Professional Summary (About Me) written for this application: it synthesizes (a) the job's key requirements — the must-have priorities from the MatchReport — with (b) the strongest matching evidence in the profile (the top-ranked experience bullets, quantified outcomes first). The summary is written in the selected output language, stays within a bounded length, is grounded — every factual statement in it traces to profile evidence, exactly like bullets — and is not a generic profile blurb: two different jobs against the same profile produce noticeably different summaries emphasizing their respective requirements.

**Why this priority**: The summary is the most-read part of the CV and the clearest expression of "evidence-backed tailoring"; it is also the piece most prone to generic filler without an explicit contract.

**Independent Test**: Generate from the same profile against two different JDs; verify each summary foregrounds its JD's must-have requirements, is fully in the output language, carries summary provenance resolving to profile evidence, contains zero numbers absent from that evidence, and differs between the two jobs.

**Acceptance Scenarios**:

1. **Given** a matched analysis, **When** the CV is generated, **Then** the Professional Summary references the job's key requirement areas and is backed by the strongest matching evidence, with `summaryProvenance` resolving into the pinned snapshot.
2. **Given** the same profile against two different job descriptions, **When** both CVs are generated, **Then** the two summaries differ and each emphasizes its own job's requirements — no one-size-fits-all blurb.
3. **Given** the selected output language (FR or EN), **When** the summary is produced, **Then** it is fully in that language with proper nouns verbatim and numbers identical to the profile.
4. **Given** the summary's factual claims, **When** the Fact Guard validates, **Then** unsupported claims in the summary block download exactly like any other claim.
5. **Given** a profile whose strongest evidence is thin for the JD's must-haves, **When** the summary is generated, **Then** it honestly reflects the available evidence without padding or invented claims.

---

### User Story 4 — Omissions Are Complete and Explain Selections (Priority: P2)

Every piece of profile content that did not make the draft is accounted for: page-budget omissions (parent behavior) plus selection omissions — entries not selected because stronger evidence was chosen — appear in the inspectable omissions list with type, identifier, and reason. The list remains reversible per the parent spec (restore → must-include → next regeneration). The omissions list is complete by construction: any profile entry the user can point at is either in the draft or in the list.

**Why this priority**: Completeness is what turns the selection from "the system hid content" into "the system made auditable choices". It completes the loop but relies on US1's selection machinery.

**Independent Test**: Use a profile where several sections exceed what fits; verify every unselected entry appears with a reason, restoring one makes it must-include for the next generation, and a fitting generation shows an empty-but-present list.

**Acceptance Scenarios**:

1. **Given** a generation where content was left out for budget OR selection reasons, **When** the omissions list is inspected, **Then** every unselected entry appears with its type, identifier, and reason distinguishing the two cases.
2. **Given** a restored omission, **When** the user regenerates, **Then** the parent spec's restore semantics apply unchanged (must-include; explicit conflict when the budget cannot fit).
3. **Given** a generation that fit everything, **When** the omissions list is inspected, **Then** it is present and empty.

---

### Edge Cases

- **Titles that cannot be truthfully improved** (short, already JD-aligned, or translation-uncertain): passed through verbatim or flagged for confirmation — never force-rewritten into something unsupported.
- **Very few relevant entries** (thin profile): the summary honestly synthesizes what exists; selection does not manufacture relevance.
- **Many near-equal entries** (ranking ties): deterministic tie-breaking keeps selection stable across regenerations; ties are visible in the selection view rather than hidden.
- **Stale match evidence** (profile edited after the match): parent's stale-analysis handling applies; ranking uses only evidence that resolves against the pinned snapshot.
- **Rewrite drift** (a title or bullet rephrased beyond recognition of its source): the Fact Guard's semantic layer flags meaning drift; the user resolves it like any claim.
- **Summary longer than its bound**: the generator shortens; the length bound is explicit in the settings contract, never silently exceeded.
- **Cross-language titles** (EN title, FR output): role titles follow the same translation rules as bullets — output language, verbatim employers, faithful credential equivalents, uncertain items flagged.
- **Restored must-include items vs selection**: a restored entry participates in selection as must-include; if it still cannot fit, the parent's explicit conflict path applies.
- **Empty experience section** (recent graduate): the summary synthesizes education/project evidence; selection never invents experience.
- **Omissions for non-experience content** (education, certifications, projects): selection omissions account for these sections too, not only experience.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Content selection MUST be deterministic and evidence-ranked — experience entries (and their roles) ordered by match evidence (requirement citations with method credit), recency, evidence strength, and impact — and the same snapshot + MatchReport MUST always produce the same selection (parent FR-003 formalized as a testable contract).
- **FR-002**: The selection outcome MUST be inspectable: for every included entry the user can see the basis of its selection (match evidence references, recency, relative rank), and every unselected entry appears in the omissions list with type, identifier, and a reason distinguishing page-budget from selection-ranking omissions (parent FR-017 extended).
- **FR-003**: Role titles of selected entries MUST be rewritten for the target job under the same rules as bullets — emphasize/shorten/align to JD terminology, output language, provenance preserved, numbers copied exactly, proper nouns verbatim — and MUST NOT invent seniority, employers, or credentials absent from the profile (extends parent FR-004 to titles).
- **FR-004**: Provenance is attached by construction, never model-claimed: every rewritten bullet MUST carry `sourceBulletIds` and every rewritten title its profile-entry provenance, both resolving into the pinned profile snapshot; every rewrite MUST remain individually inspectable against its source (rewritten text beside the profile source, with the rewrite rationale where present), and MUST be resolvable through the parent's claim-resolution flow (edit/remove/confirm) on Fact Guard flags.
- **FR-005**: The Professional Summary MUST be synthesized per generation from the job's key requirements (the MatchReport's must-have priorities) and the strongest matching evidence (top-ranked bullets, quantified outcomes first), MUST carry summary provenance resolving into the pinned snapshot, MUST respect an explicit length bound surfaced in the generation settings, and MUST be validated by the Fact Guard like every other claim (tightens parent FR-004's `summaryProvenance` into a synthesis contract).
- **FR-006**: Two different job descriptions against the same profile MUST produce different summaries, each emphasizing its own job's requirements — the summary MUST NOT be a static profile blurb (testable via a two-JD comparison).
- **FR-007**: The output language (FR/EN, user-selectable per generation, defaulting per the parent spec) MUST apply to the summary, the rewritten bullets, AND the rewritten role titles — with proper nouns verbatim, numbers identical to the profile, and uncertain translations surfaced as warnings (parent FR-015/FR-031–033 extended to titles).
- **FR-008**: The omissions list MUST be complete by construction: every profile entry is either present in the draft or listed as an omission with a reason (page budget or selection ranking); restored items follow the parent's must-include semantics; a fitting generation exposes a present-but-empty list (parent FR-005 tightened to completeness).
- **FR-009**: Rewriting MUST remain rephrasing-only while preserving factual integrity: emphasize, shorten, reorder, translate — and the Fact Guard's blocking restatement is inherited unchanged in force and extended in scope: export MUST remain blocked whenever any material claim cannot be traced to the profile (deterministic provenance/numeric checks + semantic meaning-preservation apply to rewritten titles exactly as to bullets; unsupported material claims are download-blocking blockers until edited, removed, or explicitly user-confirmed).
- **FR-010**: Regeneration behavior is inherited: changed settings (language, budget, notes) regenerate without re-entry; versions are kept; confirmations carry across regenerations for unchanged claims (parent FR-018/FR-024).

### Key Entities

All canonical schemas remain those of `ProfileForge-Specification.md` §4 and the Slice-3 data model; this feature extends two views rather than introducing new entities:

- **Selection View** (new presentation over the existing deterministic plan): per included entry — the entry, its rewritten title and bullets, its selection basis (match evidence references, recency, rank), and its rationale notes; per excluded entry — pointer into the omissions list. No new persistence beyond what the parent stores; the view is derivable from the plan and content the pipeline already produces.
- **Omission** (extended reason vocabulary): `page_budget` and `unwritten` as today, plus a selection-ranking reason distinguishing "not selected — stronger evidence chosen" from budget cuts; state machine (omitted → restored → consumed) unchanged.
- **Professional Summary** (tightened contract): output-language text of bounded length, `summaryProvenance` resolving into the pinned snapshot, synthesized from MatchReport must-have priorities + top-ranked evidence; subject to the Fact Guard like any claim.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of generated drafts expose a selection view in which every included entry shows a concrete selection basis (evidence reference or explicit recency/ranking basis), and every unselected entry appears in the omissions list with a reason — zero unaccounted profile entries.
- **SC-002**: Regenerating from an identical snapshot + MatchReport yields an identical selection (entries, order, roles) in 100% of test runs.
- **SC-003**: In every generated draft, 100% of rewritten bullets and role titles carry provenance resolving to the pinned snapshot, with zero numeric/date/metric deviations from their sources (the Fact Guard's deterministic checks pass or the claim is flagged).
- **SC-004**: All role titles of selected entries are rendered in the output language with proper nouns verbatim; benchmark cross-language runs (FR→EN, EN→FR) show 100% language compliance for titles, matching the bullets.
- **SC-005**: Summaries generated from two different job descriptions against the same profile differ from each other, and each references its own JD's key requirement areas — verified on a benchmark pair of JDs.
- **SC-006**: 100% of summary factual statements trace to summary provenance resolving into the pinned snapshot; the Fact Guard flags any summary claim without evidence.
- **SC-007**: For a fixture profile where several sections exceed the page budget, 100% of unselected entries appear in the omissions list with the correct reason, and restoring one makes it appear in the next version (or surfaces the explicit conflict).

## Assumptions

- This is a focused refinement of 003, implemented on top of its pipeline; 003's decisions (deterministic-first architecture, keyed LLM rewriting, Fact Guard layering, page budget 1–3 default 2, single template, cost caps, error taxonomy) are inherited binding constraints, not re-litigated here.
- "Roles" means the role/title of a selected experience entry; the profile has no separate Role entity, so title rewriting attaches to experience entries.
- The summary length bound is a generation setting with a sensible default (short, 2–4 sentences) and is surfaced to the user, not hidden; exact wording of the bound is a planning-stage detail.
- Selection-ranking omissions are recorded per entry (whole entries), matching the existing whole-entry-before-bullet demotion order; bullet-level omissions remain a page-budget concept.
- The selection view is derived from pipeline outputs the parent already persists (plan scores, evidence references, omissions); where the plan's internals are not currently persisted, making the view inspectable may require persisting a small derived selection record — an implementation decision for planning, not a product change.
- The two-JD summary-difference check (SC-005) uses fixed benchmark JD/profile pairs; until the Slice-4 benchmark suite exists, an inline fixture set stands in (same provisional approach as 003).
- Out of scope: changes to matching (Slice 2), the cover-letter pipeline (parent US6 — its paragraphs already follow the same evidence rules), new templates, multi-language output beyond FR/EN, and any relaxation of zero-invention or the Fact Guard.
- The five required behaviors map to: US1 (selection), US2 (rewriting + provenance attachment, user items 2–3), US3 (summary synthesis), US4 (omissions); the Fact Guard blocking restatement and the FR/EN language requirement are inherited constraints restated as FR-009 and FR-007.
