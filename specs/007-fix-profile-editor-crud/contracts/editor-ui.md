# Editor UI Contract: /profile Save Flow

**Feature**: `specs/007-fix-profile-editor-crud` | **Date**: 2026-10-26

Observable behavior of the `/profile` editor (`src/app/profile/page.tsx` + `src/components/profile/*`). This is the contract the e2e suite asserts against; `data-testid`s are part of it. Autosave delay stays 800 ms per target (page.tsx:95). The architecture stays: uncontrolled scalar inputs (`defaultValue`), save-then-refetch, no optimistic updates (research D9).

## Save status surface

Single status area next to the page heading, plus dedicated error and warning lines:

| Element | testid | Behavior |
|---|---|---|
| Status text | `save-status` | `Saving…` while a save is in flight; `Saved · v{N}` on success; `Failed` on failure (detail lives in `save-error`). Cleared to `Saving…` at the start of each attempt. |
| Error line | `save-error` | Rendered only while the latest attempt failed. Content: `{Item label} — {server message}` where the item label is the section name + entry title (e.g., `Experience at Acme — company name cannot be empty`; basics uses `Profile basics`). Cleared on the next successful save of anything. Multiple zod issues are joined (`; `) from `details[].path/message`. |
| Warning line | `save-warning` | Rendered when a successful save response carries `warnings[]`: one line per warning, `code: message` (e.g., `DATE_RANGE_OVERLAP: This role's dates overlap another role's …`). Persists until the next save of any kind. |

Error/warning visibility applies to **all** fetch paths: basics PATCH, entry PATCH, entry POST ("+ Add"), entry DELETE. A failed POST/DELETE is never silent (today only entry PATCH shows anything, and `patchProfile`/`addEntry`/`deleteEntry` drop failures — research D7). Network failure (fetch rejects / non-JSON) surfaces as `Failed — could not reach the server`.

## Basics editing

- Each field schedules a debounced save. Pending edits to different basics fields are **merged** into the flushed patch (research D8) — two quick edits on different fields must both persist.
- Clearing an optional field sends `null`; the field saves as empty. Clearing `name` → 400 → `save-error` shows `Profile basics — …name…`; the typed state remains visible (no silent revert); a reload shows the last saved value.
- Invalid email → 400 with the same surfacing.

## Entry field editing

- Each `section-entry-field` schedules a debounced PATCH with exactly `{ [field]: value }` (plus the parsing rules below). Only that field is applied server-side (strict patch); bullets, `order`, sibling fields, and provenance metadata are untouched.
- Value parsing before send (research D5): empty input → `null` for optional scalars; `skillsUsed`/`aliases` → comma-split array (empty input → `[]`); required text fields send the raw string (empty → server 400, surfaced).
- An entry the user has confirmed, or one imported from a document, stays editable; its provenance badge and review metadata are unchanged by field edits (FR-003).

## Bullets (experience / projects)

- `+ Bullet` appends a **local draft** (no network call). Draft text is editable; a draft persists server-side only once its text is non-empty (included in the next debounced bullets save). An abandoned empty draft is discarded (research D3).
- Editing any bullet text / removing a bullet schedules a debounced PATCH with the full bullet array (existing bullets carry their `id`s; server syncs by id — stable across saves).
- While a save is in flight or after a refetch, in-progress draft/typing state is not clobbered: reconciliation from server state skips targets with unsaved local changes (research D9).
- The existing Confirm button (flagged bullets on imported entries) and per-bullet provenance badges behave as today.

## Add / remove entries

- `+ Add` in every section POSTs the section's placeholder payload (research D4); on success the refetched list shows the new editable row, focused for editing. The section may start empty.
- Duplicate skill via `+ Add` or editing a skill name → 409 → `MergeOrKeepDialog` (`dupSkill` flow, unchanged).
- `Delete` on any entry confirms (browser confirm, unchanged) and DELETEs; on success the row disappears after refetch, `save-status` shows the new version, version history refreshes. On failure → `save-error`.

## Restore interplay

After restoring a version, the editor refetches; all CRUD works on the restored entries (new ids) exactly as on live content (FR-019).

## Testids inventory (e2e contract)

Existing (kept): `add-{section}`, `save-status`, bullet textareas (`bullet-{id}` when persisted), `MergeOrKeepDialog` internals, provenance badges.
New: `save-error`, `save-warning`.
