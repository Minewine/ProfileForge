# Generation Pipeline Contract — Stages, Ranking, Fact Guard, Fitting, Gate

The deterministic core of Slice 3 (analogue of slice 2's matching-engine contract). Every stage is pure except the marked LLM/persistence stages; cancellation is checked at every boundary.

## Stage machine (`src/lib/generation/pipeline.ts`)

```text
[1] preconditions & pin      validate analysis=matched, dates resolved; pin ProfileSnapshot at
                             profile.version; resolve MatchReport evidence refs against the
                             snapshot; dangling refs → skipped + job.notice = "stale-analysis"
[2] content plan (det.)      rank entries, build ordered plan, skills list, must-include set;
                             must-include pre-check → fail PAGE_BUDGET_CONFLICT if it cannot fit
[3] LLM draft (premium)      keyed rephrase/translate; merge with provenance passthrough (R7)
[4] Fact Guard               deterministic layer (always) → semantic layer (economy);
                             report persisted with the version
[5] render & fit             pdf-lib single-column render; measure-and-demote loop → omissions
[6] extraction gate          two-level check on the produced PDF; bounded re-render retries (3)
[7] artifacts & persist      write pdf (only if gated) / docx / letter txt to disk; store version,
                             artifacts metadata, usage totals; status → succeeded
```

Failure semantics: stages 3–6 surface the LLM taxonomy / gate codes in `statusError`; partial artifacts are discarded; nothing fabricated substitutes for failed AI output (FR-020). Stage 4 semantic-layer failure does **not** fail the job — it blocks download (`FACTGUARD_UNAVAILABLE`, fail-closed) so regeneration cost is preserved (research R8).

## Content ranking (deterministic, stage 2)

Per entry (experience bullet, education, project bullet, certification):

```text
score = 0.45·relevance + 0.25·strength + 0.15·impact + 0.15·recency   (weights v1, tunable constants)

relevance = w1·(is MatchReport evidence for a matched requirement? method-weighted:
             exact 1.0 / approved_alias 0.9 / semantic 0.7) + w2·(normalized keyword overlap
             with requirements ∪ recommendedKeywords)      — per entry, scaled to [0,1]
strength  = evidence-ref count (capped) + provenance confidence + containmentOk bonus
impact    = presence of quantified outcomes (numbers/percentages/durations in source text)
recency   = entry end date rank (newest = 1.0, linear decay to 0 at 15 years)
```

- **Experience entries** are ranked as units; bullet order within an entry follows the same per-bullet score. **Whole-entry demotion before bullet demotion** when fitting.
- **Skills list**: exact/approved-alias matched skills only, rendered in JD terminology (the JD requirement text when it matched a profile skill), ranked by requirement importance then match credit, capped by fitting. Deterministic — no LLM involvement.
- **Must-include**: restored omissions (`restoredMustInclude`) and basics (name/contact) are exempt from demotion; the stage-2 pre-check estimates their rendered height (conservative bound) and fails `PAGE_BUDGET_CONFLICT` early if they alone cannot fit (SC-006: explicit, never silent).

## Fact Guard — codes and layers (stage 4)

| Code | Layer | Severity | Condition |
|---|---|---|---|
| `DANGLING_PROVENANCE` | deterministic | blocker | claim's sourceBulletIds / EvidenceRef ids do not resolve in the pinned snapshot |
| `UNSUPPORTED_CLAIM` | deterministic + semantic | blocker | material claim with no resolvable provenance; or semantic verdict `unsupported` |
| `NUMERIC_MISMATCH` | deterministic | blocker | a number/year/percentage/duration token in the claim is absent from its cited evidence (normalized comparison — identical rule for FR/EN) |
| `SKILL_UNVERIFIED` | deterministic | blocker | skills-section entry is neither a pinned-profile skill nor an exact/approved-alias match |
| `MEANING_DRIFT` | semantic | blocker | semantic verdict `drifted`, or claim missing from verdicts (conservative default) |
| `LETTER_DUPLICATES_CV` | deterministic | blocker | letter paragraph ≥0.95 normalized containment vs any current-CV bullet/summary (letters only) |
| `UNCERTAIN_TRANSLATION` | semantic | warning | LLM signaled an unfaithful translation candidate (proper nouns/credentials) |
| `VERBATIM_FALLBACK` | deterministic | warning | plan key the LLM skipped → source-language verbatim text used (cross-language outputs) |

Deterministic layer runs with zero AI and always executes (FR-008); `layersRun.semantic = false` ⇒ download blocked regardless of flag counts (FR-010). Resolution states and the download gate matrix are defined in the data model.

## Page-budget fitting (stage 5)

Render → count pages (pdf-lib measures exactly) → while `pages > budget` and demotable items exist: demote the lowest-scored demotable (whole entry first, then bullets) to `content.omissions {type, id, reason: "page_budget"}` → re-render. No fixed quotas anywhere (FR-003). If nothing demotable remains and still over budget → fail `PAGE_BUDGET_CONFLICT` with guidance (raise budget or trim profile). Cover letter: fixed 1-page budget, same loop, paragraphs as the demotion unit (rare; expected to fit).

## Extraction gate (stage 6) — the two-level check (FR-013)

Applied to the rendered PDF bytes with `unpdf` (`extractPdfPages`) and normalized comparison (`normalizeText`):

- **Level 1 — structural (100% required)**: name; every non-empty contact item (email/phone/links); every rendered section heading (bilingual map in the template: Professional Summary/"Résumé professionnel", Experience/"Expérience professionnelle", Education/"Formation", Skills/"Compétences", optional Projects/Certifications/Languages); every rendered experience entry's company, title, and both dates — each recoverable as a normalized substring of the extracted text.
- **Level 2 — per-block word recovery (≥95%)**: every rendered content block (summary, each bullet, each education/certification entry, each letter paragraph) vs its source string via `checkContainment` (existing 0.95 threshold; case/accent/whitespace/punctuation-insensitive — identical rules for FR and EN, so legitimate French accents never fail the gate).
- Failure ⇒ re-render attempt (deterministic renderer + sanitization fallback pass; max 3 attempts total) ⇒ still failing ⇒ job fails `EXPORT_GATE_FAILED`; full per-element/per-block results are stored in `extractionCheck`; the failing artifact is never written to the download location and never offered (SC-003).

## Rendered template invariants (stage 5, single template — FR-011/FR-012)

Single column; standard headings in the output language from the fixed bilingual map; dates rendered as normalized `YYYY-MM` / `present`; no content in PDF headers/footers (none exist) or images (none); WinAnsi-safe text (characters outside the standard-font encoding are transliterated/sanitized before draw, with a unit test locking diacritic behavior — é/è/ç/à must pass through untouched); name/contact as body text at the top of page 1; section order: Summary, Experience, Education, Skills, then optional Projects/Certifications/Languages when content exists (no empty headings).

## Scenario references

- SC-002 ← stage 4 (all codes) + keyed drafting (no unkeyed claims can exist).
- SC-003 ← stage 6 gate + artifact-write policy.
- SC-004/SC-006 ← stage 2 pre-check + stage 5 loop + omission restore.
- SC-005 ← numeric identity rules + verbatim-proper-noun prompt constraint + `VERBATIM_FALLBACK` visibility.
- SC-007 ← stage failure semantics + `INTERRUPTED` recovery + fail-closed download gate.
- SC-008 ← `LETTER_DUPLICATES_CV`.
