# Contract — Fact Guard UX: Blocked Exports & Flag Explanations

> **DEPRECATED (2026-10-28)**: the Fact Guard UX was removed with the Fact Guard
> itself — no blockers, no claim review, no confirmation flows. Draft warnings
> (VERBATIM_FALLBACK / UNCERTAIN_TRANSLATION) render as a passive "Draft notes"
> block; downloads are gated only by artifacts + the PDF extraction check. This
> document remains for historical context only.

**Feature**: 006-polish-reliability (US2, FR-005–FR-007; SC-002) · **Date**: 2026-10-25

The guard's *semantics are frozen* (fail-closed, inherited from 003): this contract pins
only what the user reads. Gate state derivation is defined in
[data-model.md](../data-model.md) (ExportGateState); all strings below are rendered in
the Downloads section of `GenerationPanel`, one block per closed gate, in this order.

## Download-area gate explanations (required text)

| Gate | Heading | Explanation (exact or equivalent) |
|---|---|---|
| `blockersPending` | "Claims need review first" | "{n} claim(s) don't trace cleanly to your profile yet. Review them below — edit, remove, or confirm each one. Downloads unlock when every blocker is resolved." — the "{n}" token links/scrolls to the claim review list. |
| `validationIncomplete` | "Validation is incomplete" | "The meaning-check could not run (the AI judge was unavailable), so downloads stay closed as a precaution. Your claims have NOT failed — regenerate to run the check again." |
| `verificationFailed` | "The PDF failed verification" | "The rendered document didn't pass text-layer verification, so no file was stored. Regenerate to retry." — plus the existing level-1/level-2 recovery summary already rendered (`GenerationPanel` gateFailed block). |
| open | (no block) | Existing per-format download buttons enabled; existing footnote retained. |

The one-line disabled-button reason (`downloadDisabledReason`) stays as the compact
fallback (tooltips), but the explanation blocks above are the primary surface.

## Flag-kind explanations (`FLAG_EXPLANATIONS`, one sentence each)

Rendered under every pending flag row in `ClaimReview`, next to the machine code.

| Code | Severity | Explanation (exact or equivalent) |
|---|---|---|
| `NUMERIC_MISMATCH` | blocker | "A number in this claim doesn't match your profile evidence — fix it or confirm the correct figure." |
| `MEANING_DRIFT` | blocker | "This claim appears to say more than your profile evidence supports — tighten it, remove it, or confirm it's accurate." |
| `UNSUPPORTED_CLAIM` | blocker | "Your profile has no evidence backing this claim — add evidence in the profile, remove it, or confirm it." |
| `DANGLING_PROVENANCE` | blocker | "This claim points to profile content that no longer exists — re-match the job, edit the claim, or remove it." |
| `LETTER_DUPLICATES_CV` | blocker | "This sentence repeats your CV almost word for word — rephrase it in the letter." |
| `SKILL_UNVERIFIED` | blocker | "This skill isn't in your profile or the matched requirements — add it to the profile or re-run the match, then regenerate." |
| `VERBATIM_FALLBACK` | warning | "The AI didn't rewrite this item, so your original wording is used unchanged." |
| `UNCERTAIN_TRANSLATION` | warning | "The AI wasn't sure about this translation — double-check the wording." |

## Completeness guard (test contract)

`tests/unit/client-messages.test.ts` asserts: the key set of `FLAG_EXPLANATIONS`
equals the union of ValidationFlag codes emitted by `src/lib/generation/factguard.ts`
and `src/lib/generation/draft.ts` (kept in sync via an explicit expected-codes list in
the test; corrected 2026-10-25 — SKILL_UNVERIFIED added, INCONSISTENT_STATE removed as
a profile-claims code that never appears in generation reports). A new code without an
explanation fails CI. Every explanation is one sentence, imperative, and names the
resolution action(s) available on the row.

## Resolution interplay (unchanged, restated for the contract)

Edit / Remove / Confirm remain the only actions (`ClaimReview`, routes under
`/api/generations/[id]/document/claims/[claimId]`). Confirm resolves only identical
claims in future versions (fingerprint, R10). The blocked state clears through the
existing `onChanged` refresh — no new endpoint, no polling change.
