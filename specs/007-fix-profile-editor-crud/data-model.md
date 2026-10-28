# Data Model: Fix Profile Editor CRUD

**Feature**: `specs/007-fix-profile-editor-crud` | **Date**: 2026-10-26

**No database changes.** The Prisma schema (`prisma/schema.prisma`) is untouched — every fix is behavioral. This document records the entity shapes as the editor and its save paths must treat them, the validation rules, and the state transitions that the contracts in `contracts/api.md` rely on. Source of truth: `prisma/schema.prisma:45-232`.

## Entities

### Profile (one row)
| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | |
| `version` | Int, default 1 | Incremented by **every** successful mutation (`commitMutation`); a full snapshot is written per version |
| `language` | String (`fr` \| `en`) | |
| `basics` | Json? | `{ name (required), headline?, summary?, location?, email?, phone?, links? (url[], ≤10) }` — replaced wholesale on PATCH |
| `experiences`, `educations`, `skills`, `languages`, `projects`, `certifications` | relations | Ordered by `order asc` on read (`src/lib/profile/repository.ts:64-71`) |
| `snapshots` | ProfileSnapshot[] | |

### Experience
`company` (required), `title` (required), `location?`, `startDate?` (`YYYY-MM`), `endDate?` (`YYYY-MM` | `"present"` | null), `skillsUsed` (String[]), `order` Int, plus shared provenance block (below). Has ordered `bullets`.

### Bullet
Nullable owner FKs `experienceId` / `projectId` / `educationId` (exactly one set; cascade delete with owner), `text` (required, 1–2000), `order` Int, plus provenance block + `containmentOk?`. **`id` must remain stable across edits** — `PinnedSnapshotSchema` requires it (`src/lib/generation/plan.ts:39`) and Fact Guard indexes per-bullet text/provenance.

### Education
`institution` (required), `degree?`, `field?`, `startDate?`, `endDate?`, `grade?`, `order`, provenance block. Has `bullets` relation (bullet editor UI covers experience/projects; the model supports education bullets — no UI change in this feature).

### Skill
`name` (required, unique per profile — case/accent-insensitive check, `assertSkillNameFree` repository.ts:320-330), `category?`, `aliases` (String[]), `level?` (user-stated only), `order`, provenance block.

### LanguageSkill
`name` (required), `proficiency?`, `order`, provenance block.

### Project
`name` (required), `description?`, `link?` (url), `startDate?`, `endDate?`, `order`, provenance block. Has ordered `bullets`.

### Certification
`title` (required), `issuer?`, `issueDate?` (`YYYY-MM`), `order`, provenance block.

### Provenance block (shared by all section entries and bullets)
| Field | Type | Meaning |
|---|---|---|
| `provenance` | `imported` \| `user_entered` \| `user_confirmed` (default `user_entered`) | Origin of the content |
| `sourceDocumentId` / `sourceLocator` | String? / Json? (`{ page?, paragraphIndex?, section? }`) | Required iff `imported` (create-time invariant, `applyProvenanceInvariants`) |
| `language` | `"fr" \| "en"?` | Set from the source document at import |
| `confidence` | Float 0–1? | Must be null for non-imported (invariant) |
| `reviewFlag` | `low_confidence` \| `containment_failed` \| `ambiguous_date` \| `missing_dates`? | Set by import pipeline; cleared on `user_confirmed` |

### ProfileSnapshot (immutable)
`profileId`, `version` (unique per profile), `cause` (`import` | `edit` | `restore`), `data` Json = exact `serializeProfile` output (all six section arrays with all scalar columns incl. `id`, nested bullets for experience/projects). Consumed by generation via `PinnedSnapshotSchema` — **contract to preserve**.

## Validation rules (editor save paths)

- **Create** (`POST /api/profile/entries/[section]`): section input schema + provenance invariants; required field per section (see entities); skill name uniqueness → `409 DUPLICATE_SKILL` with `details.existingId/existingName`. Unknown section → 404.
- **Update** (`PATCH /api/profile/entries/[section]/[id]`): **strictly partial** — only keys present in the body are applied (D1/R1); absent keys never take schema defaults. `null` is valid for every `.nullish()` optional and clears the field. `""` is invalid for date fields (`YearMonthSchema`) — the UI maps empty → `null` before sending.
- **Basics** (`PATCH /api/profile`): `{ basics?, language? }`; `name` min 1, `email` must parse as email when present. Replaces `basics` wholesale.
- **Bullets**: sent as an array on experience/project PATCH; diffed by `id` (D2) — update in place / create missing / delete absent. `text` min 1; the UI never sends empty drafts (D3).
- Every successful mutation bumps `Profile.version` and writes a snapshot; POST/PATCH responses may carry `warnings: [{ code, message }]` (currently `DATE_RANGE_OVERLAP`, experience only) — non-blocking.

## State transitions

### Provenance (`applyProvenanceTransition`, repository.ts:221-238)

| From \ To | `user_entered` | `user_confirmed` |
|---|---|---|
| `user_entered` | no-op (same value) | allowed |
| `imported` | allowed — explicit re-attribution; clears `reviewFlag`, `confidence`, `sourceDocumentId`, `sourceLocator` | allowed **only with an open `reviewFlag`**, else 400; clears `reviewFlag` |
| `user_confirmed` | rejected (400) | no-op |

- **Absent `provenance` key in a PATCH means no transition at all** (the fix of record — today a defaulted `user_entered` in every patch causes transitions A2/A3, see research R1).
- Ordinary field edits never change provenance or review metadata (FR-003).

### Profile version / snapshot lifecycle
Every create/update/delete/import/restore → `version += 1`, snapshot row with matching `cause`. Restore (`POST /api/profile/versions/[version]/restore`) deletes all entries and reinserts snapshot content with **new ids**; restored content is then edited like live content (FR-019) — nothing in the save paths may assume id permanence across restores.

## Integrity invariants downstream (must not break)

- `serializeProfile` output keys: `id, version, language, basics, experience, education, skills, languages, projects, certifications, lowConfidenceCount, updatedAt` — unchanged.
- `PinnedSnapshotSchema` (`src/lib/generation/plan.ts:36-107`): requires top-level `id/version/language`; entry `id` and bullet `id` required; `.catch([])` on section arrays. Bullet sync (D2) keeps ids valid.
- Fact Guard evidence: skill/language names, cert `title · issuer`, education `degree/field/institution`, bullet text (with per-bullet provenance) — all preserved by strict patches + id-preserving bullet sync.
- Template export reads snapshot `basics` + sections and resolves entries by id — unchanged.
