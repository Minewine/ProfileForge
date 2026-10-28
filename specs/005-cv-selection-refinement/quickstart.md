# Quickstart — Explicit, Evidence-Backed Selection & Rewriting

Prerequisites: the Slice-3 stack (matched analysis; `npm run db:migrate` applies the new `selection` migration), fixture profile + matched analysis from `specs/003-cv-generation/quickstart.md` scenarios 1–5.

## Automated checks

```bash
npm test   # extended suites:
           #   tests/unit/generation-plan.test.ts      (selection cut: caps, budget scaling, determinism SC-002,
           #                                           restore interplay, selection-record building)
           #   tests/unit/generation-draft.test.ts     (title keyed merge, verbatim fallback, omissions seeding,
           #                                           payload conformance incl. summaryRequirements/summaryMaxWords)
           #   tests/unit/generation-factguard.test.ts (title claims: numeric + semantic + claim-route ops)
           #   tests/unit/generation-verify.test.ts    (level-1 title check against the RENDERED title)
           #   tests/integration/generations-api.test.ts (selection persisted + returned; omissions completeness;
           #                                           title persistence; two-JD payload difference — SC-005 mechanism)
npm run test:e2e   # extended 004 specs: selection view visible with basis; rewritten title rendered;
                   # omissions list shows selection reasons on a rich profile
```

## Manual / live validation scenarios

1. **Selection view** — generate from a rich profile (more entries than the cap) → open the document → SelectionView shows each included entry with its rank, evidence links, and recency; the omissions list shows every unselected entry with reason "selection". Expect: zero unaccounted entries (SC-001/SC-007).
2. **Determinism** — regenerate with identical settings → the selection (entries, order, ranks) is identical (SC-002).
3. **Rewritten titles** — generate with output language EN and FR → each selected entry's title differs from the verbatim source where the rewrite serves the JD, is fully in the output language, keeps the employer verbatim, and the drill-down shows rewritten-vs-source side by side (SC-003/SC-004).
4. **Title claim flow** — edit a rewritten title → re-validation runs; delete it → falls back to the verbatim snapshot title; a title with an invented number → `NUMERIC_MISMATCH` blocker → download blocked until resolved.
5. **Summary synthesis** — run the SAME profile against two different JDs → the two summaries reference their own JD's must-have areas and differ (SC-005 live spot-check); each summary's provenance resolves into the snapshot; a summary claim without evidence blocks download (SC-006).
6. **Summary length bound** — set summary length to 30 words → the rendered summary respects it (count words); set 120 → respected.
7. **Omissions restore across reasons** — restore a `selection`-omitted entry → regenerate → it appears (must-include); over-restore beyond the budget → explicit `PAGE_BUDGET_CONFLICT` (parent semantics unchanged).
8. **Pre-feature versions** — open a document generated before this feature → SelectionView shows "not recorded", claim flows still work (backward compatibility).

## Expected outcomes (definition of slice success)

- SC-001/SC-007: every profile entry is in the draft or in the omissions list, with the reason distinguishable — verified by unit + integration suites and scenario 1.
- SC-002: deterministic selection — scenario 2 + plan unit tests.
- SC-003/SC-004: provenance-carrying rewrites incl. titles, FR/EN compliance — scenarios 3–4 + suites.
- SC-005: two-JD summary difference — payload mechanism tests (automated) + live spot-check (scenario 5).
- SC-006: summary claims fully grounded — Fact Guard tests + scenario 5.
- Failure semantics unchanged from the parent: any untraceable material claim still blocks export.

## SC-005 live spot-check record

**Pending a key** — as of 2026-10-25 the SC-005 live half (scenario 5: two real JDs
against the same profile with a live premium model, comparing the two generated
summaries) has not been executed: no OpenRouter key is configured in this
environment. The automated mechanism half IS covered: two reports with different
must-haves produce different `summaryRequirements` payloads
(tests/unit/generation-draft.test.ts, "SC-005") and the prompt contract
(contracts/selection-rewriting.md §Summary synthesis) threads them into the
summary instruction. Run scenario 5 manually once a key is configured and record
the result here.

## Phase 8 addendum (designed template)

The designed two-column template (`templateId: "designed"`; assets/
ProfileForge-CV-Template.docx) is selectable per generation — the single-column
ATS layout stays the default. Output language extends to DE (explicit selection;
the detection default remains FR-else-EN). All multi-value lists render
dynamically from the plan/content (no fixed slot counts), and the designed PDF
passes the same two-level extraction gate (tests/unit/generation-designed.test.ts,
integration "Phase 8").
