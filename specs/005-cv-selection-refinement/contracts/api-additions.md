# Contract — API Additions

All existing routes and the error envelope are unchanged; this feature adds one response field and one settings field. Full route contract: `specs/003-cv-generation/contracts/api.md`.

## GET /api/generations/[id]/document (extended payload)

- Adds `selection`: the persisted `SelectionRecord` (`{included: [{entryId, kind, rank, score, basis: {evidenceRefs, methodCredits, recency}}], generatedAt}`) from the current version, or `null` for versions produced before this feature.
- `content.experience[].title` appears for rewritten titles (`{claimId, text, sourceTitle}`); absent for pre-feature versions.
- `omissions` (already returned) may now carry `reason: "selection"` alongside `page_budget` / `unwritten`.

## POST /api/generations (settings input)

- `settings.summaryMaxWords?: number` (30..120; default 60) — validated with the existing settings schema; stored frozen on the job; surfaced on the 202 response body like the other settings.
- No other request changes: `kind`, `outputLanguage`, `pageBudget`, `tone`, `notes` unchanged.

## UI (no route changes)

- `SelectionView` renders from the document payload's `selection` + existing evidence map: per included entry — rank within section, score, evidence-ref links (reusing the drill-down's evidence-by-id map), recency; a "not recorded" state for pre-feature versions; the omissions list already renders reasons and gains the `selection` reason label.
- The generation settings form gains the summary length control (`summaryMaxWords`).
