# Quickstart — Slice 3 Validation Guide

Prerequisites: `docker compose up -d` (Postgres on :5433), `.env` set (`DATABASE_URL`, `OPENROUTER_API_KEY`), `npm run db:migrate`, `npm run fixtures` (regenerates test CVs). A profile imported from `tests/fixtures/cv-en.pdf` (or `cv-fr.pdf`) and a **matched** analysis (finalize requirements → run match in `/jobs/[id]`) are the pipeline's entry conditions — see `specs/002-jd-matching/quickstart.md` scenarios 1–5 to produce one.

## Automated checks

```bash
npm test   # full suite; slice-3 suites:
           #   tests/unit/generation-plan.test.ts        (ranking, skills list, must-include pre-check)
           #   tests/unit/generation-draft.test.ts       (keyed merge, unkeyed-drop, verbatim fallback)
           #   tests/unit/generation-factguard.test.ts   (every code in contracts/generation-pipeline.md,
           #                                            #  fail-closed, numeric identity FR/EN)
           #   tests/unit/generation-fit.test.ts         (demote loop, omissions, PAGE_BUDGET_CONFLICT)
           #   tests/unit/generation-verify.test.ts      (two-level gate: pass, structural fail,
           #                                            #  <95% block fail, accent-insensitivity)
           #   tests/unit/generation-template.test.ts    (single column, bilingual headings, diacritics)
           #   tests/integration/generations-api.test.ts (job lifecycle, claim resolution, omissions
           #                                            #  restore, download gating — mocked callLLM)
```

## Manual / live validation scenarios

1. **Generate CV (EN, default budget)** — `/jobs/[id]` (matched analysis) → Generate CV with defaults. Expect: job appears `queued` → `running` → `succeeded` via polling; document shows claims with provenance drill-down, Fact Guard summary (0 blockers typical), omissions (possibly empty), and enabled PDF/DOCX download.
2. **French output from English profile** — same analysis, output language `fr`. Expect: headings "Résumé professionnel / Expérience professionnelle / Formation / Compétences"; narrative in French; employer/institution names verbatim in English; every number/date identical to the profile (spot-check 3 metrics).
3. **Blocker blocks download** — edit a claim to add "+50% revenue" absent from evidence → Expect: `NUMERIC_MISMATCH` blocker appears; PDF/DOCX/TXT downloads all return `BLOCKERS_UNRESOLVED`; revert the edit (or confirm) → downloads re-enabled.
4. **Confirm persists** — confirm the blocker instead of reverting → regenerate (same settings) → Expect: the unchanged claim arrives already `user_confirmed`; a changed claim re-validates fresh.
5. **Omission restore** — generate with page budget 1 on a rich profile → Expect: non-empty omissions with reasons; restore one experience entry → regenerate → Expect: the entry appears; restoring more than fits yields the explicit `PAGE_BUDGET_CONFLICT` failure with guidance (never silent re-omission).
6. **Extraction gate proves itself** — download the PDF, select-all/copy in a viewer (or `pdftotext`) → Expect: name, headings, company/title/dates all selectable; accented names intact. (The gate already verified ≥95% word recovery per block before offering the file.)
7. **Cancel & retry** — start a generation, cancel mid-run → Expect: `cancelled`, no version created; from a failed job (e.g., invalid key), retry → Expect: attempt increments, fresh usage/run shown, succeeds after fixing the key.
8. **Cover letter complements** — Generate cover letter (tone: enthusiastic, language `fr`). Expect: 1 page, motivation-oriented, no verbatim CV bullets (copy a CV bullet's distinctive phrase — it must not appear); PDF download gated identically; "Copy as plain text" produces the letter body.
9. **Fail-closed Fact Guard** — with a valid key but an unreachable model for the guard task (misconfigure the economy model id) → Expect: document generates, download blocked with `FACTGUARD_UNAVAILABLE`, deterministic flags still listed; restore the model → re-validate via a claim touch → download unblocks.
10. **Stale analysis notice** — after generating once, delete a profile entry that backed a match, then regenerate → Expect: job carries the `stale-analysis` notice; the deleted entry's content is absent; nothing dangles.

## Expected outcomes (definition of slice success)

- Every material claim in any generated CV/letter resolves to pinned-snapshot evidence or a recorded confirmation — zero fabricated content (SC-002); the deterministic Fact Guard layer flags every injected numeric/dangling-reference violation in the automated suites.
- 100% of offered PDFs pass both gate levels; no failing artifact is ever downloadable (SC-003) — verified by unit suites with deliberately corrupted renders and by scenario 6.
- Typical generations fit the selected page budget without iteration; when they don't, omissions are listed with reasons and restores land in the next version or surface an explicit conflict (SC-004/SC-006).
- FR↔EN outputs are fully in the output language with verbatim proper nouns and identical numbers/dates/metrics (SC-005) — scenarios 2 and 10.
- All failure paths (invalid key, cost-cap stop, guard unavailability, gate failure, interrupted process) end in visible, actionable, retryable states with prior work preserved (SC-007) — scenarios 7 and 9.
- Letters contain no verbatim CV reuse (SC-008) — scenario 8 plus the `LETTER_DUPLICATES_CV` unit tests.

## Spec-coverage sweep (T054, 2026-10-24)

Every FR and SC of `specs/003-cv-generation/spec.md` maps to automated coverage or a quickstart scenario:

| Requirement | Coverage |
|---|---|
| FR-001 (async jobs, settings, retry/cancel) | integration `generations-api.test.ts` (POST guards/202, cancel/retry, lifecycle) + unit pipeline |
| FR-002 (pin at job start, version recorded) | integration US1 (pinned profileVersion, stale-analysis notice) |
| FR-003 (evidence-aware selection, budget as constraint) | unit `generation-plan.test.ts` (ranking/weights) + `generation-fit.test.ts` (demote loop) |
| FR-004 (sourceBulletIds / provenance on every claim) | unit `generation-draft.test.ts` + integration US1 (provenance resolves) |
| FR-005 (omissions inspectable/reversible, explicit conflict) | integration US5 (restore → consume; over-restore → PAGE_BUDGET_CONFLICT) + unit fit |
| FR-006 (no gap masking, no unsupported skills) | unit `generation-factguard.test.ts` (SKILL_UNVERIFIED) + plan (deterministic skills) |
| FR-007/FR-008/FR-009 (Fact Guard layers, codes, blockers gate) | unit factguard (every code, fail-closed, fingerprints) + integration US2 (block→edit/confirm→unblock) |
| FR-010 (fail-closed) | unit (layersRun.semantic=false ⇒ gate closed) + integration (semantic outage ⇒ FACTGUARD_UNAVAILABLE) |
| FR-011/FR-012 (single template, headings, skills in JD terms) | unit `generation-template.test.ts` (bilingual headings, single column, diacritics) + plan skills tests |
| FR-013 (two-level extraction gate, bounded retries) | unit `generation-verify.test.ts` + integration US3 (gate failure → EXPORT_GATE_FAILED, no artifact; retry) |
| FR-014 (DOCX best-effort ungated) | integration US3 (docx served blocker-gated) |
| FR-015 (output language rules, numeric identity) | unit `generation-language.test.ts` + integration US4 (FR↔EN round-trips) |
| FR-016/FR-017 (letter complementarity, tone, txt) | unit `generation-letter.test.ts` (LETTER_DUPLICATES_CV) + integration US6 (tone/budget defaults, txt download) |
| FR-018 (regeneration versions, reports stored) | integration US1 (version 2 appends) + repository tests |
| FR-019 (tiers, cost cap) | router-level (existing tier wiring) + per-run usage in polling GET; cap itself covered by slice-1 usage tests |
| FR-020 (AI failure taxonomy, no fabrication) | integration (semantic-error path preserves honest report) + existing LLM error mapping |
| SC-001 | manual scenario 1 (timing, live key) — automated jobs complete well under budget in tests |
| SC-002 | unit factguard codes + keyed-draft design (unkeyed impossible) + benchmark lands in Slice 4 |
| SC-003 | unit verify + integration US3 (failing artifact never written/downloadable) |
| SC-004/SC-006 | unit/integration fit + US5 restore loop |
| SC-005 | integration US4 numeric identity; verbatim proper nouns prompt-locked + VERBATIM_FALLBACK visibility |
| SC-007 | integration failure paths (cancel/retry, gate failure, guard outage, INTERRUPTED recovery) |
| SC-008 | unit complementarity + integration LETTER_DUPLICATES_CV blocker |

Follow-up notes: (1) SC-001's live timing and quickstart scenarios 1–10 need a real OpenRouter key — manual validation is documented above and remains for the user; (2) benchmark-scale verification of SC-002/SC-004/SC-005/SC-008 lands with the Slice-4 evaluation suite (assumption recorded in spec.md); (3) the profile page's date-overlap warning is API-level only (editor UI does not render response `warnings`) — discovered while building these suites, recorded as a product finding for a later slice.

## Independent review record (2026-10-25)

An independent read-only review pass (invariants + adversarial code reading) verified all five non-negotiable invariants HOLD (zero-invented-facts, fail-closed gate, pinned snapshot, artifact-write policy, key hygiene). Verdict was fix-then-ship; the following were fixed immediately: **P0-1** letter payload `jdDigest.role: null` failed the task's zod schema (every real letter generation would have failed — invisible while `callLLM` is mocked; fixed + schema-conformance regression tests for all three task payloads); **P1-1** a best-effort DOCX/TXT failure could discard the gate-verified PDF (now non-fatal, PDF mandatory); **P1-2** a gate-failed regeneration hijacked the document's "current version", breaking prior verified downloads (versions now resolve by requesting job; cross-job readers use the latest *successful* version); **P2-1** cancel landing inside a stage now records `cancelled` not `failed`; **P2-7** artifact reads are path-contained; **P2-8** stranded `queued` jobs (dead process, cancelled-while-queued) are swept to `INTERRUPTED`/recoverable states.

Remaining accepted follow-ups (not fixed here): **P2-2** semantic-layer outage discards the root cause (cost-cap vs key-invalid indistinguishable in `FACTGUARD_UNAVAILABLE`; re-validation mints uncapped fresh runIds); **P2-3** numeric-identity is token-set based (sign flips and compound numbers pass; "1,500" vs "1500" flags — safe direction, user friction); **P2-5** letter-omission restore is stored but never consumed by the letter plan; **P2-6** the must-include pre-check runs at stage 5 (post-draft) instead of stage 2, burning the premium call on doomed restores; **P2-9** concurrent same-document jobs can race version numbering (raw Prisma P2002 surfaces as INTERNAL_ERROR); dead code: `parseClaimId`, `waitForJobSettled` (exported, unused).
