# Contract — UI States: Progress, Loading, Disabled-with-Reason

**Feature**: 006-polish-reliability (US3, FR-008/FR-009; SC-003) · **Date**: 2026-10-25

Presentational contract only — no API, polling, or state-machine changes. All states are
derivable from data the components already hold.

## Generation progress (FR-008)

While `job.status ∈ {queued, running}` (`ACTIVE_STATUSES`, `GenerationPanel.tsx:92`):

1. A persistent progress indicator is rendered adjacent to the status badge — CSS
   animation (pulse), no raster/asset dependency, visible at all viewport sizes. It is
   removed exactly when a terminal status (`succeeded|failed|cancelled`) renders.
2. The indicator also renders while `busy` (a generation POST is in flight) so the gap
   between click and first poll tick never looks idle.
3. Every control disabled by an active job or `busy` (template/language/budget/summary
   selects, notes textarea, both generate buttons, restore buttons) carries
   `title="Generation in progress"` (or visible suffix where a label exists). The
   existing `disabled={busy || active}` wiring stays; this adds the *reason*.

## Loading states (FR-009)

| View | State |
|---|---|
| Analysis detail page (`/jobs/[id]`) | "Loading…" main content until the analysis fetch settles (exists at `page.tsx:155,413` — kept, and the document panel must not render "finished-looking" empty states while its first poll is in flight). |
| Generation document panel | Before the first poll resolves: a single loading line ("Loading document…"), not the downloads section, not empty lists. |
| Upload page in-flight parse/import | Existing "Parsing…"/busy button text retained; parse may take >60s on free models — the busy state must persist for the whole fetch, with no timeout-induced reset. |

## Test contract

- `tests/e2e/08-generation-views.spec.ts` extends: with a job in a non-terminal state
  (seeded queued job), the progress indicator is visible; disabled generate buttons
  expose the reason (title attribute).
- Unit/integration suites unaffected functionally; existing 303 vitest + 15 e2e must
  stay green (no behavioral selector changes to asserted elements — new elements only).

## Non-goals (this slice)

- Stage-level progress ("drafting… guarding… rendering…") — needs a new API (spec
  Assumption 3).
- Global toast system, skeletons library, route-level transition animations.
