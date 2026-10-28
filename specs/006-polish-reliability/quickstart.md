# Quickstart: Polish & Reliability Slice — Validation Guide

**Feature**: 006-polish-reliability · **Date**: 2026-10-25

Prerequisites: dev environment running (`npm run dev`, PostgreSQL via
`docker compose up -d db`), an OpenRouter key configured in Settings (or
`OPENROUTER_API_KEY`), profile seeded with at least two experience entries.

## Automated suites (must all be green)

```bash
npx tsc --noEmit          # clean
npm run lint              # 0 errors
npx vitest run            # all suites incl. the new message-map/completeness/matrix tests
npm run test:e2e          # all specs incl. the extended 08-generation-views
```

New/extended coverage this feature adds (see contracts for exact strings):

1. **Message matrix** (`tests/unit/llm-errors.test.ts`, `tests/unit/client-messages.test.ts`)
   — every `LLM_*` code has server text + client action; every Fact Guard flag code has
   a one-sentence explanation; unknown codes pass through with no invented guidance;
   overlap messages contain no "please verify".
2. **Overlap contract** (`tests/integration/generations-api.test.ts`) — the
   `PROFILE_DATES_CONFLICT` error body matches the new wording; a resolved-overlap
   profile generates normally.
3. **Export matrix** (`tests/integration/generations-api.test.ts`) — for each template
   (`ats`, `designed`) × each output language (`fr`, `en`, `de`): job succeeds, PDF
   artifact `gate: "verified"`, extracted text contains the expected localized headings
   and accented characters, DOCX (downloaded bytes) carries the right template markers
   (ATS: no table; designed: 3663/6803 grid + `E8F0F8`).
4. **UI states** (`tests/e2e/08-generation-views.spec.ts`) — progress indicator visible
   for a non-terminal job; disabled generate controls expose their reason.

## Manual scenarios (smoke-test failures → now fixed)

1. **Dead model slug → actionable error** (US1/SC-001): Settings → set economy model to
   a nonexistent slug → upload a CV → parse. Expect: the error names the provider
   problem with a Settings/retry action (not bare "temporarily unavailable"); the dev
   console shows the provider status + body snippet (FR-002), with no key material.
2. **Zero credit → quota message** (US1): with a zero-credit key, select a paid premium
   model → parse/generate. Expect: "credit is exhausted" text + top-up/Settings action.
3. **Overlap → editor-directed message** (US1): give two experience entries overlapping
   dates → generate. Expect: the conflict text points at the Profile editor's date
   fields and never says "verify". Fix the dates in the editor → generation proceeds.
4. **Blocked export explains itself** (US2/SC-002): generate with a model that trips
   the Fact Guard (or confirm pending blockers exist) → open the generation panel.
   Expect: a "Claims need review first" block with the count linked to the review list;
   each flag row shows a one-sentence explanation beside its code; after
   editing/removing/confirming the last blocker, downloads enable on the next refresh.
5. **Validation-incomplete state** (US2): simulate the meaning-check failing (e.g.
   invalid premium model mid-run or the existing FACTGUARD_UNAVAILABLE flow) → Expect:
   "Validation is incomplete" wording — explicitly NOT "claims failed" — with the
   regenerate suggestion; downloads stay closed.
6. **Progress during generation** (US3/SC-003): start a real generation → observe the
   panel for the whole run: pulsing indicator beside the status badge, controls disabled
   with a visible reason, terminal transition unmistakable. No idle-looking window.
7. **Dual-template export** (US4/SC-004): generate the same document twice — once with
   "ATS — single column", once with "Designed — two column" — in EN, then FR, then DE.
   Download PDF + DOCX each time. Expect: every download succeeds; ATS PDFs are
   single-column, designed PDFs show the shaded sidebar; FR/DE accents render correctly
   in both formats; no download silently uses the other template.

## Recorded run

**2026-10-25** — implementation complete, all gates green:

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (7 pre-existing warnings in untouched files).
- `npx vitest run` — **327 passed (27 files)**, up from 303: new suites
  client-messages (9) + llm-errors (8), integration overlap-contract test (+1),
  US4 export matrix (+6).
- `npm run test:e2e` — **16 passed, 1 skipped** (the pre-existing key-gated upload
  spec): spec 08 extended with the blocked-export explanations (T008) and the
  queued-job progress indicator (T011).

Deviations / notable findings during implementation:

1. Flag-code inventory corrected against the real emitters: `SKILL_UNVERIFIED` added to
   `FLAG_EXPLANATIONS`; `INCONSISTENT_STATE` (and MISSING_LOCATOR/CONTAINMENT_UNRESOLVED)
   are profile-claims codes, never generation ValidationFlags — contract updated in step.
2. The provider-detail log must read the response body **after** the retry decision —
   reading earlier consumed the body and broke the 429/5xx retry path (caught by
   tests/unit/llm-router.test.ts).
3. Manual scenarios 1–2 (dead slug / zero-credit key) could not be re-walked live in this
   session — the environment's key currently has credit via free models only; the message
   matrix is verified by tests/unit/llm-errors.test.ts against the exact contract strings.
   Scenario 3 (overlap) verified by the integration test; scenarios 4–7 verified by the
   e2e + matrix suites.
