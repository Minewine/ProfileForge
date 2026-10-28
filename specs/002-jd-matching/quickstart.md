# Quickstart & Validation Guide: Slice 2

Run these scenarios end-to-end to prove the slice works. Contracts: [api.md](./contracts/api.md), [matching-engine.md](./contracts/matching-engine.md), [llm-tasks.md](./contracts/llm-tasks.md); data model: [data-model.md](./data-model.md). Prerequisites and setup are identical to Slice 1 (see [../001-ats-cv-tailoring/quickstart.md](../001-ats-cv-tailoring/quickstart.md)) — plus a profile with some content (import any CV first).

## Automated checks

```bash
npm test   # new suites: unit/matching-engine, unit/score (deterministic tables),
           # unit/llm-jobs-tasks (mocked fetch), integration/jobs-api (test DB, mocked LLM)
```

## Manual / live validation scenarios

1. **Paste & extract (EN)** — `/jobs` → paste an English JD → create (language `en` detected) → Extract → requirement list with categories, must/nice, hard-constraint flags → edit one requirement, delete another, add one → Finalize → Match. Expect: report in < 2 min total; every requirement has status/method/evidence-or-gap; score + breakdown visible; usage ≤ 2 LLM calls, cost within cap.
2. **Paste & extract (FR)** — French JD → `fr` detected; "exigé/obligatoire" vs "atout" respected; requirement text stays French through the report.
3. **Cross-language match** — English JD mentioning "project management" / "Kubernetes" against a French profile (or reverse): the built-in bilingual aliases and accent-insensitive normalization produce exact/alias matches — no false gaps from language alone.
4. **Hard-constraint honesty (SC-007)** — JD requiring a certification the profile lacks: report shows **gap** even if bullets "feel" close; the Confirm button is absent or rejected unless a semantic proposal existed for it.
5. **Evidence drill-down** — click any matched requirement: evidence entries with snippets point at real profile entries (skills, bullets, certifications); nothing dangling.
6. **Semantic validation (SC-005)** — unit-level by design; live signal: the report's `semanticDropped` metric appears in the analysis view whenever proposals were dropped.
7. **Score reproducibility (SC-004)** — `npm test -- score` recomputes frozen fixtures; live: reopening a stored report always shows the same numbers (persisted JSONB, version-pinned).
8. **History & re-run** — after matching, edit the profile (add a required skill + use it in a role), then Re-run: a new analysis appears (chained via re-run), scores the updated profile, and the old report still shows its original numbers and pinned version.
9. **Degraded semantic (FR-014)** — temporarily set an invalid economy model in Settings → Match succeeds with exact/alias-only results and a visible "semantic unavailable" notice; restore the model.
10. **Guards** — 150-char JD → `JD_TOO_SHORT`; >100k chars → `JD_TOO_LONG`; Match before Finalize → `409 INVALID_STATE`; DELETE an analysis → gone (requirements cascade).

## Expected outcomes (definition of slice success)

- Scenarios 1–10 pass; automated suites green; ESLint/tsc/build clean.
- 100% of report requirements carry status + method + evidence-or-gap; zero dangling EvidenceRefs.
- No hard constraint is marked met by semantic matching without recorded user confirmation.
- Stored reports never change without an explicit recompute/re-run action.
