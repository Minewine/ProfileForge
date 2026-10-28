# Contract — Error Messages & Failure Surfaces

**Feature**: 006-polish-reliability (US1, FR-001–FR-004; SC-001) · **Date**: 2026-10-25

The error envelope is unchanged (`src/lib/api/errors.ts:86-91`):
`{ "error": { "code": string, "message": string, "details": unknown | null } }`.
This contract pins the **message text and action pointers** per failure class. Messages
are English, one to two sentences, and every message contains exactly one next action.

## LLM provider failures (thrown in `src/lib/llm/errors.ts`, `keyStore.ts`, `router.ts`)

| Code | Server message (required text or equivalent) | Client action pointer (client-messages.ts) |
|---|---|---|
| `LLM_KEY_INVALID` | "The OpenRouter key was rejected. Open Settings to update the key." | "Open Settings to update the key." |
| `LLM_QUOTA` | "OpenRouter credit is exhausted — paid models cannot run until you top up. Top up credit or switch to a free model in Settings." | "Check models and key in Settings." |
| `LLM_RATE_LIMITED` | "The AI provider is rate-limiting requests. Wait a moment and retry." | "Retry in a moment." |
| `LLM_UNAVAILABLE` | "The AI provider could not be reached. Retry — your work so far is preserved." (the redacted diagnostic appended by `router.ts:203-206` stays) | "Retry; if it persists, check the selected model in Settings." |
| `LLM_SCHEMA_REPAIR_FAILED` | (existing text) + " Retry, or switch models in Settings." | "Retry or switch models in Settings." |

**FR-002 diagnostic retention**: when a provider call fails, the router logs
`console.warn(redact(...))` with the HTTP status and a short (≤200 char) response-body
snippet before mapping to the user-facing code. Never logs the API key, full prompts,
or full responses. Existing call sites that already log must not regress.

## Profile conflicts

| Surface | Required text (replaces current wording) |
|---|---|
| `DATE_RANGE_OVERLAP` warning (`repository.ts` `detectDateOverlap`) | "This role's dates overlap another role's — open the Profile editor and adjust the Start/End dates so each role has its own period." |
| `PROFILE_DATES_CONFLICT` guard (`repository.ts` `findDateOverlapConflict` caller) | "The profile has overlapping experience dates, so a tailored CV cannot be generated. Open the Profile editor and adjust the flagged Start/End dates (each role needs its own period), then generate again." |

Forbidden: the phrase "please verify" (no verify action exists — spec FR-003).

## Generation-job failures (rendered from `job.statusError`, format `CODE: message`)

Existing pipeline messages already carry cause + remedy (`PAGE_BUDGET_CONFLICT`,
`EXPORT_GATE_FAILED` — `fit.ts`, `pipeline.ts`). Contract additions:

1. The client FailureNotice renders the code as a badge/mono token and the remainder as
   the message (split on the first `: `).
2. Action pointers by code: `PAGE_BUDGET_CONFLICT` → "Raise the page budget, un-restore
   items, or regenerate."; `EXPORT_GATE_FAILED` → "Regenerate to retry the export.";
   unknown codes → "Regenerate; if it persists, check Settings."

## Client module (`src/lib/client-messages.ts`, research R6)

```text
describeError(code: string, message: string) -> { message: string; action: string | null }
LLM_ERROR_GUIDANCE: Record<"LLM_KEY_INVALID" | "LLM_QUOTA" | "LLM_RATE_LIMITED"
                           | "LLM_UNAVAILABLE" | "LLM_SCHEMA_REPAIR_FAILED", string>
```

- Pure data + functions; zero imports (client-component safe).
- `describeError` passes unknown codes through with `action: null` (never invents guidance).
- Unit-tested for: every LLM code present; unknown-code passthrough; overlap strings
  do NOT contain "verify" (checked against the live server messages via the
  integration suite, keeping the contract and code honest in one place).
