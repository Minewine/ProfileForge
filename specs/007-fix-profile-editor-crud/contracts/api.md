# API Contract: Profile Editor Endpoints

**Feature**: `specs/007-fix-profile-editor-crud` | **Date**: 2026-10-26

Base: same-origin JSON API under `/api/profile`. Authentication: none (single-user local app). All errors use the single envelope below; all successful mutations return the new profile `version`.

**Contract changes in this feature are marked ⚠ CHANGE.** Endpoint URLs, methods, success status codes, the DTO shape, and the error envelope are unchanged.

## Error envelope (unchanged, `src/lib/api/errors.ts:85-110`)

```jsonc
// any non-2xx
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ { "path": "company", "message": "…" } ] } }
```

Codes relevant to the editor: `VALIDATION_ERROR` (400), `NOT_FOUND` (404, unknown section/entry), `DUPLICATE_SKILL` (409, `details.existingId`/`details.existingName`), `INTERNAL_ERROR` (500). Zod failures are always 400 `VALIDATION_ERROR` with per-issue `details`.

## `GET /api/profile`

200 → `{ profile, lowConfidenceCount, hasDraftAwaitingImport }` where `profile` is the `serializeProfile` DTO (top-level keys `id, version, language, basics, experience, education, skills, languages, projects, certifications, lowConfidenceCount, updatedAt`; section entries carry all scalar columns incl. `id`, `provenance`, `order`, and nested `bullets` for experience/projects). **Unchanged.**

## `PATCH /api/profile` — basics

Request (unchanged shape): `{ "basics"?: { name, headline?, summary?, location?, email?, phone?, links? }, "language"?: "fr" | "en" }`

- `basics`, when present, replaces the stored basics object wholesale (name required min 1; email must be a valid email when present; ≤10 url links).
- 200 → `{ version }`. Failures: 400 `VALIDATION_ERROR` (empty name, malformed email).

## `POST /api/profile/entries/[section]`

`section` ∈ `experience | education | skills | languages | projects | certifications`. Body: full section input schema (with defaults and provenance invariants — **unchanged**). The editor always sends a minimal valid payload (placeholders, research D4):

```jsonc
// experience            → { "company": "New role", "title": "Title" }
// education             → { "institution": "New education" }
// skills                → { "name": "New skill" }
// languages             → { "name": "New language" }
// projects              → { "name": "New project" }
// certifications        → { "title": "New certification" }
```

201 → `{ id, version, warnings }`. Duplicate skill name → 409 `DUPLICATE_SKILL`. Unknown section → 404. `warnings` (currently `DATE_RANGE_OVERLAP`, experience only) is non-blocking.

## `PATCH /api/profile/entries/[section]/[id]` — ⚠ CHANGE (semantics)

Body: **strictly partial** section patch. Only keys present in the JSON body are applied; absent keys never take schema defaults and never touch stored values. This is the fix of record (research R1/D1) — before this change, defaulted keys (`provenance`, `order`, `skillsUsed`, `aliases`, `bullets`) were fabricated into every patch.

Per-key semantics:

- Any editable scalar: present → validated and applied. `null` on a `.nullish()` field → clears it (e.g., `{"startDate": null}`). `""` on a date field → 400 (the UI converts empty inputs to `null` before sending).
- `skillsUsed` / `aliases` (experience / skills): present → replaces the array wholesale (may be `[]`).
- `order`: present → applied as sent (the UI does not currently edit it; the API keeps supporting it).
- `provenance`: present and different from stored → explicit transition (rules in `data-model.md`); absent → **no transition, no metadata change**.
- ⚠ `bullets` (experience / projects): present → replaces the bullet set via **id-preserving sync** (research D2), replacing the previous delete-all + recreate:
  - item with `id` that exists under the entry → update `text`/`order` in place; provenance fields on the item are applied only when provided; `sourceDocumentId`/`sourceLocator`/`language` are never modified unless provided;
  - item without `id` → created with `text` (1–2000 chars — the UI never sends empty drafts, research D3); provenance defaults to `user_entered` (newly typed text is the user's, not the document's) unless the payload provides one; server assigns `id`;
  - existing bullet `id` absent from the array → deleted with its row;
  - `text` must be 1–2000 chars — the UI never sends empty drafts (research D3);
  - response carries no per-bullet results; the client refetches.

200 → `{ version, warnings }`. 404 unknown entry/section. 400 invalid value or unsupported provenance transition.

## `DELETE /api/profile/entries/[section]/[id]`

200 → `{ version }`. Entry and its bullets are removed (cascade). **Unchanged.**

## Versions (unchanged)

`GET /api/profile/versions` → list; `POST /api/profile/versions/[version]/restore` → restores snapshot content (entries reinserted with new ids), `{ version }`. Restored content must be editable like live content.

## Consumers (must keep working unchanged)

- Editor page `src/app/profile/page.tsx` (sole in-app consumer).
- `tests/e2e/scripts/seed.ts` create-with-bullets payloads (`bullets` riding along on POST remains supported via `insertEntry`).
- Integration tests importing route handlers directly (`tests/integration/profile-editor.test.ts`, `tests/integration/generations-api.test.ts:212-214` — its field-only date PATCH now applies only those fields).
- Downstream: `src/lib/generation/**` (pinned snapshots, Fact Guard, template export) — no changes; snapshots written by the new save paths must validate against `PinnedSnapshotSchema`.
