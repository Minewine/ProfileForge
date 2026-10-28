# Contract — Selection Cut, Title Claims, Summary Synthesis, Omission Reasons

The deterministic core of feature 005 (extension of `specs/003-cv-generation/contracts/generation-pipeline.md`; that contract remains binding where not modified here).

## Selection cut (stage 2 addition)

After deterministic ranking (unchanged weights and tie-breaking), the plan stage drafts only:

```text
caps at budget 2 (tunable constants v1):
  experience       4 entries
  projects         2 entries
  education        3 entries
  certifications   3 entries
budget scaling:    budget 1 → max(1, floor(cap/2));  budget 3 → cap + 1
must-include:      restored omissions are always drafted and do NOT consume a cap slot
```

- Unselected entries are appended to `content.omissions` as `{type: <section>, id: <entryId>, reason: "selection"}` at draft time (before the fit loop), so the omissions list is complete by construction (spec FR-008).
- Within a section, order = score desc; ties break deterministically (snapshot order) — SC-002's stability.
- The fit loop is unchanged: it trims bullets/entries for the page budget with `page_budget` reasons on top of the cut.
- The per-entry `rank` recorded in the selection record is 1-based within the section BEFORE the cut (a must-include low-ranked entry records its true rank).

## Title claims (stages 2–6)

- Plan: one title item per SELECTED experience entry — key `expTitle.{experienceId}`, kind `title`, sourceText = `[snapshot title]`, provenance = the entry id, score = the entry's score (whole-entry demotion removes the title with the entry).
- Task: the premium output's `items[]` includes the title keys; the same zero-invention prompt constraints apply (output language, verbatim employers, numbers copied exactly, no invented seniority/credentials).
- Merge: keyed merge sets `experience[].title = {claimId, text, sourceTitle}`; skipped key → verbatim snapshot title + `VERBATIM_FALLBACK` warning; unkeyed items dropped as always.
- Fact Guard: `collectCVClaims` adds title claims (evidence = the entry's snapshot title/company ref); the deterministic layers (dangling provenance, unsupported, numeric identity) and the semantic layer apply unchanged. Claim routes: `expTitle.{id}` parses via `parseClaimId`; PATCH edits the rewritten text; DELETE falls back to the verbatim snapshot title (never title-less); confirm records the fingerprint.
- Renderers (PDF + DOCX): draw `content.title.text` when present, else the snapshot title; the extraction gate's level-1 `experience:{id}:title` element checks the RENDERED title string.

## Summary synthesis (stage 3)

- Task input gains `summaryRequirements` (top ≤5 must-have requirement texts from the finalized report, may be empty) and `summaryMaxWords` (from settings, 30..120).
- Prompt constraint replaces the hardcoded 60-word line: *"Write a Professional Summary of at most {summaryMaxWords} words that connects the candidate's strongest evidence to these job requirements: {summaryRequirements}. Reference the requirement areas explicitly; no generic profile blurb; zero invention; output language; verbatim proper nouns; numbers exactly as in the sources."*
- `summarySources` (top-ranked bullets) and `summaryProvenance` are unchanged; two different reports MUST produce different `summaryRequirements`/source orderings (payload-difference test for SC-005's mechanism).

## Omission reasons (complete vocabulary)

| Reason | Producer | Meaning |
|---|---|---|
| `selection` | plan stage | whole entry not selected — stronger evidence chosen (within the section cap) |
| `page_budget` | fit loop | drafted but demoted to fit the page budget |
| `unwritten` | letter merge | letter angle the model skipped |
| `unwritten` + title fallback | draft merge | title/bullet key the model skipped (content falls back; the warning flag records it — not an omission entry for CVs) |

## What does not change

Ranking weights, must-include semantics, the fit loop's demotion tiers, the Fact Guard layers/codes/gate, page-budget conflict handling, claim-resolution flows, artifact gating, the two-level extraction gate (modulo the rendered-title check), and all letter behavior.
