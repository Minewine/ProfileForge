# Research: Polish & Reliability Slice

**Feature**: 006-polish-reliability · **Date**: 2026-10-25 · **Input**: spec.md (US1–US4, FR-001–FR-011, SC-001–SC-004) + feature-005 smoke-test findings (2026-10-25, recorded in the feature-005 session and the spec Context).

Each decision: **Decision / Rationale / Alternatives considered**. File references are `path:line` against the current tree.

## R1 — Where cause-specific error messages live (US1, FR-001/FR-002/FR-003/FR-004)

**Decision**: Server-side message text is the single source of truth; a thin client-safe
map (`src/lib/client-messages.ts`) adds the *action pointer* per error code (e.g.
`LLM_KEY_INVALID` → "open Settings"). Provider failure detail (HTTP status + short body
snippet, secrets redacted) is logged server-side at the throw site in
`src/lib/llm/router.ts` (`postWithRetry` catch, ~line 193) so diagnosis no longer
requires decrypting the key; the user-facing message keeps using the existing
`{error: {code, message, details}}` envelope (`src/lib/api/errors.ts:86-91`).

**Rationale**: Every API route funnels errors through `errorResponse`, and every client
page already has a private `readError` that renders `body.error.message` (e.g.
`src/app/upload/page.tsx:37-40`). Changing message text at the source therefore updates
every surface at once — upload, jobs list, analysis page, generation panel — with zero
plumbing. The action pointer cannot live in the server message without coupling server
copy to UI navigation, and cannot live only client-side without duplicating cause
detection; a code-keyed map is the smallest seam. The smoke test proved the diagnostic
gap: `minimax/minimax-m3.1-flash:free` 404'd and surfaced as generic "temporarily
unavailable" with nothing logged.

**Alternatives considered**:
- *Client-only message map for everything* — rejected: duplicates cause classification
  per page and leaves server logs empty (FR-002 unmet).
- *Structured error details payload with i18n keys* — rejected: single-language product,
  no user-facing benefit today, larger contract change.
- *New `/api/errors/log` endpoint* — rejected: FR-002 asks for server-side retention,
  which a `console.warn` + redaction at the router satisfies with zero new surface.

The concrete message matrix (per LLM code, per pipeline failure code, overlap rewrite)
is specified in [contracts/error-messages.md](./contracts/error-messages.md).

## R2 — Blocked-export (Fact Guard) UX (US2, FR-005/FR-006/FR-007)

**Decision**: The generation panel derives a **gate state** from data already in the
polled payload — no API change: `blockersPending` (`summary.blockers > 0`),
`validationIncomplete` (`!layersRun.semantic`), `verificationFailed` (`extractionCheck`
present and `!passed`), else open. The download area renders a per-gate explanation block
for every closed gate (strings in [contracts/fact-guard-ux.md](./contracts/fact-guard-ux.md)),
replacing the current one-line `downloadDisabledReason`
(`src/components/generation/GenerationPanel.tsx:283-287`). Flag explanations are a
static client-safe map keyed by flag code in `src/lib/client-messages.ts`; `ClaimReview`
renders the explanation line under each flag. A unit test cross-checks the map against
the full code set the Fact Guard emits (`NUMERIC_MISMATCH`, `MEANING_DRIFT`,
`UNSUPPORTED_CLAIM`, `DANGLING_PROVENANCE`, `LETTER_DUPLICATES_CV`, `INCONSISTENT_STATE`
+ draft warnings `VERBATIM_FALLBACK`, `UNCERTAIN_TRANSLATION`) so a future code cannot
ship unexplained. Resolution actions stay as-is (edit/remove/confirm in `ClaimReview`);
the existing `onChanged` refresh clears the blocked state (FR-007 already satisfied by
the refresh loop — verified in the feature-003 suites).

**Rationale**: `computeDownloadable` (`src/lib/generation/repository.ts`) already
encodes the three gates; the information needed for the explanation is entirely present
client-side in the polled document payload, so any server change would be redundant.
The smoke run's 19 × MEANING_DRIFT with only a count shown is the exact gap; per-code
one-liners fix comprehension without touching guard semantics (fail-closed stays).

**Alternatives considered**:
- *Extend `computeDownloadable` to return reasons* — rejected: the client already has
  every input; a server change would only mirror them.
- *Per-flag dynamic explanations from the server* — rejected: flags are static kinds;
  a map keyed by code is deterministic, testable, and adds no payload weight.
- *Toast/tooltip-only guidance* — rejected: the export area is where the user looks;
  guidance must be inline and persistent (SC-002).

## R3 — Progress & loading indicators (US3, FR-008/FR-009)

**Decision**: Presentational only. (a) The status badge in `GenerationPanel` gains an
animated indicator while `ACTIVE_STATUSES` includes the job status ("queued"/"running")
— a small CSS pulse, no new component dependency; (b) every control disabled by an
active job gets a `title` (and where visible, suffix text) stating "generation in
progress"; (c) data-loading views keep/standardize their "Loading…" state
(`src/app/jobs/[id]/page.tsx:155,413` already does this — the smoke test's blank-panel
observation was an in-app-browser hydration artifact, confirmed by the Playwright e2e
suite rendering the same page correctly).

**Rationale**: Spec Assumption 3 explicitly scopes this slice to presentational
progress. The panel already polls every 1500 ms (`POLL_MS`, `GenerationPanel.tsx:91`);
the indicator attaches to state that already exists, so there is nothing to fetch and
nothing to keep in sync.

**Alternatives considered**:
- *Pipeline stage streaming (SSE/poll stage field)* — rejected: new API surface for
  perceived polish only; explicit spec assumption excludes it this slice.
- *Skeleton components everywhere* — rejected: the app has exactly two data-loading
  views (analysis detail, document panel inside it); a consistent text/indicator state
  is proportionate.

Full behavioral contract in [contracts/ui-states.md](./contracts/ui-states.md).

## R4 — Dual-template export verification (US4, FR-010/FR-011)

**Decision**: No renderer changes unless the new matrix tests find a defect. Add an
integration download-matrix test: for each template (`ats`, `designed`) × each output
language (`fr`, `en`, `de`), generate (mocked LLM echoing plan keys, supported verdicts),
assert the job succeeds, the stored PDF passes the extraction gate, the artifact row is
`verified`, and — where the suite already unzips DOCX (`tests/unit/generation-designed.test.ts`
does) — the downloaded bytes carry the expected template markers (ATS: no `<w:tbl>`;
designed: 3663/6803 grid + `E8F0F8`). Accented-content correctness is asserted via the
existing extraction-gate containment (accent-insensitive normalization) plus explicit
`é`/`ü` presence checks on extracted text.

**Rationale**: Artifacts are baked at persist time from the version's frozen settings
(`templateId` resolved per generation since feature-005 Phase 8), so "downloads respect
the selected template" is by construction — the plan-stage risk is a language × template
interaction the unit fixtures miss (e.g. German umlauts through the WinAnsi sanitizer in
the designed sidebar; `sanitizeWinAnsi` keeps Latin-1, `ü` ∈ Latin-1, verified by
existing template tests — but the *matrix* was never run end-to-end). Coverage-first is
the honest scope for a polish slice.

**Alternatives considered**:
- *Re-render on download with current settings* — rejected (and contradicts the spec):
  downloads serve the version's stored artifacts; re-rendering would break the
  gate-verified guarantee.
- *Visual regression screenshots* — deferred: valuable but a separate toolchain
  decision; the text-layer + structural markers cover "clean export" as specified.

## R5 — Overlap conflict message rewrite (US1 scenario 4, FR-003)

**Decision**: Rewrite the two strings in `src/lib/profile/repository.ts`
(`detectDateOverlap`'s warning at ~line 346 and the `PROFILE_DATES_CONFLICT` guard
message at ~line 355) to name the overlapping-date problem and direct the user to the
profile editor's date fields on the flagged entries; remove the "please verify" phrasing
entirely. The API `details` already carries the code; the client renders the message as-is.

**Rationale**: The "verify" action does not exist anywhere in the codebase (confirmed by
grep — only detect/flag/guard paths); the message currently dead-ends exactly as the
smoke test showed. The editor already surfaces the per-entry overlap warning
(`DATE_RANGE_OVERLAP` warning from create/patch flows), so pointing there describes a
path that actually works today.

**Alternatives considered**:
- *Implement an explicit "verified overlap" acknowledgment flag* — rejected for this
  slice per spec Assumption 1 (mechanism out of scope; message-only fix).
- *Auto-resolve overlaps by nudging dates* — rejected: silently mutating user data is
  worse than a clear message.

## R6 — Shared client-safe message module (US1+US2)

**Decision**: New `src/lib/client-messages.ts` exporting: `LLM_ERROR_GUIDANCE`
(code → one-line action), `FLAG_EXPLANATIONS` (code → one-sentence explanation), and a
`describeError(code, message)` helper returning `{message, action}`. Pure data + string
functions, zero imports — safe for client components under the established
no-`node:`-imports convention (the local view-type comments in `GenerationPanel.tsx`
document why). Unit-tested directly (`tests/unit/client-messages.test.ts`) for
completeness against the code inventories in the contracts.

**Rationale**: Both US1 action pointers and US2 flag explanations are static
code-keyed strings used by multiple client components; one module avoids four copies of
`readError`-adjacent logic drifting. Direct unit testability without rendering.

**Alternatives considered**:
- *Per-component constants* — rejected: drift risk across the four surfaces.
- *Server-provided strings in every payload* — rejected: bloats payloads and couples
  copy to API versioning for no current i18n need.
