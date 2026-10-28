# Data Model: Polish & Reliability Slice

**Feature**: 006-polish-reliability · **Date**: 2026-10-25

**No schema changes.** No Prisma migration, no new tables, no new JSONB shapes. The
entities below are *derived view states* computed from data already persisted by
features 001–005; this document pins their derivation so the UI and its tests share one
definition.

## Derived entities

### ExportGateState (US2, FR-005)

Computed in `GenerationPanel` from the polled document payload — never stored.

```text
ExportGateState = {
  blockersPending:      boolean   # summary.blockers > 0
  validationIncomplete: boolean   # validationReport.layersRun.semantic === false
  verificationFailed:   boolean   # extractionCheck present AND extractionCheck.passed === false
  open:                 boolean   # none of the above AND at least one artifact downloadable
}
```

Sources (all already in the `GET /api/generations/[id]` payload):
`document.summary.blockers`, `document.version.validationReport.layersRun.semantic`,
`document.version.extractionCheck`. Semantics inherited unchanged: any closed gate
disables every download button (`computeDownloadable` in
`src/lib/generation/repository.ts` remains the server-side authority; the client state
is explanatory only, so the two can never disagree about *whether*, only add *why*).

### FailureNotice (US1, FR-001–FR-004)

A rendering of the existing error envelope — no new stored shape.

```text
FailureNotice = {
  code:    string   # error.code from the API envelope, or job.statusError's leading token
  message: string   # server-provided cause text (single source of truth)
  action:  string   # client-derived from code via LLM_ERROR_GUIDANCE / defaults (research R6)
}
```

Surfaces: upload page (`readError`), jobs list, analysis page failure panel
(`job.statusError`, e.g. `PAGE_BUDGET_CONFLICT: …` / `EXPORT_GATE_FAILED: …`),
generation panel inline error. Job failure strings keep the established
`CODE: message` format produced by `describeStageError` (`src/lib/generation/pipeline.ts:103-108`);
the client splits on the first `:` for the action lookup and renders the remainder verbatim.

### FlagExplanation (US2, FR-006)

Static map keyed by flag code — the complete inventory the Fact Guard + draft merge emit:

```text
blockers:      NUMERIC_MISMATCH | MEANING_DRIFT | UNSUPPORTED_CLAIM | DANGLING_PROVENANCE
             | LETTER_DUPLICATES_CV | INCONSISTENT_STATE
warnings:      VERBATIM_FALLBACK | UNCERTAIN_TRANSLATION
```

Authoritative emission sites: `src/lib/generation/factguard.ts` (deterministic +
semantic layers), `src/lib/generation/draft.ts` (`VERBATIM_FALLBACK`,
`UNCERTAIN_TRANSLATION`). A unit test asserts `FLAG_EXPLANATIONS` covers exactly the
union of codes these modules emit (guards against an unexplained future code).
Explanation strings are pinned in [contracts/fact-guard-ux.md](./contracts/fact-guard-ux.md).

## Persisted shapes touched (read-only references)

| Shape | Feature | Why referenced here |
|---|---|---|
| `ValidationReport.flags[]` `{code, claim, severity, resolution}` | 003 | flag code drives the explanation map |
| `GenerationJob.statusError` | 003 | failure-notice source for job failures |
| `GeneratedDocumentVersion.extractionCheck` | 003 | verification-failed gate input |
| `GenerationSettings.templateId` | 005 Ph.8 | per-version template identity for the export matrix (R4) |

## State transitions

None new. Existing transitions this feature makes *legible* (not different):

- blocked export → open: last blocker resolved (edited/removed/confirmed) → refresh →
  `blockersPending` false and `validationIncomplete` false and `verificationFailed` false.
- job running → failed: `statusError` populated → FailureNotice with code + cause + action.
- provider failure: `LLM_*` code thrown → envelope → FailureNotice with action pointer;
  provider status/detail additionally logged server-side (R1).
