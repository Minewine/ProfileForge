# Research: Fix Profile Editor CRUD

**Feature**: `specs/007-fix-profile-editor-crud` | **Date**: 2026-10-26

All unknowns were resolved by direct code investigation (read-only exploration, verified against the installed zod 4.6.7). No `[NEEDS CLARIFICATION]` items remain from the spec. Each decision below states what was chosen, why, and what was rejected.

## R1. Why field edits currently destroy data — root cause verified

**Finding**: `PatchSchemas` in `src/lib/profile/sectionSchemas.ts:15-31` are built as `XInputSchema.partial()`. In zod 4, `.partial()` does **not** suppress `.default()` — verified empirically against the installed zod 4.6.7: `ExperienceInputSchema.partial().parse({ company: "X" })` returns `{ provenance: "user_entered", company: "X", skillsUsed: [], order: 0, bullets: [] }`. Every `.default()` field fires on absent keys (`src/lib/validation/schemas.ts:36, 87-89, 105`).

Downstream in `updateEntry` (`src/lib/profile/repository.ts:180-211`) the always-present defaulted keys cause four distinct failures:

| Failure | Mechanism |
|---|---|
| Field edit deletes all bullets | `patch.bullets` is always `[]` → `rewriteBullets(tx, section, id, [])` runs `deleteMany` (repository.ts:199-200, 262-280) |
| Confirmed entries cannot be edited | defaulted `provenance: "user_entered"` ≠ existing `"user_confirmed"` → `applyProvenanceTransition` throws `VALIDATION_ERROR` (repository.ts:187, 237) |
| Imported entries silently de-imported | same defaulted provenance passes the imported→user_entered transition, then `buildEntryUpdate` nulls `reviewFlag/confidence/sourceDocumentId/sourceLocator` (repository.ts:234-236, 252-257) |
| `skillsUsed`/`aliases` wiped, `order` reset to 0 | defaulted keys copied by `buildEntryUpdate` (repository.ts:242-245); reads order by `order asc` (repository.ts:64-71) so entries visibly jump after reload |

**Decision**: Fix at the schema layer — patch validation must be strictly partial: a key absent from the request body is absent from the parsed patch. See D1.

## D1. PATCH semantics: strict partial patches (defaults stripped)

**Decision**: Introduce defaults-free patch variants of the section input schemas (required fields relaxed to optional, `.default()` → `.optional()`, provenance fields optional, provenance invariants not applied to patches) and use them in `PatchSchemas`. `updateEntry`/`buildEntryUpdate` then apply only the keys actually sent. `CreateSchemas` (create-time invariants, defaults) stay unchanged.

**Rationale**: Minimal-diff fix at the root cause; keeps the existing endpoint-per-entry contract; the UI's per-field autosave payload `{ [field]: value }` becomes exactly what the server applies. Explicit `provenance` changes (the Confirm button) still trigger the transition machinery because the key is then genuinely present.

**Alternatives considered**:
- *UI sends whole entries on every edit*: rejected — larger payloads, still requires server-side merge to avoid clobbering, and it widens the race window between concurrent debounced saves.
- *Reuse create schemas with `.partial()`*: rejected — that is today's broken behavior (R1).

## D2. Bullets: id-preserving sync instead of delete-all + recreate

**Decision**: Replace `rewriteBullets` (delete-all + recreate, repository.ts:262-280) with a `syncBullets(tx, owner, ownerId, bullets)` that diffs by `id`: incoming bullets whose `id` exists under the owner are updated in place (`text`, `order`, and provenance fields only when provided); incoming bullets without `id` are created (as `user_entered` — newly typed text is the user's, not the document's, unless the payload explicitly says otherwise); existing bullet ids absent from the payload are deleted. `sourceDocumentId`/`sourceLocator`/`language` are never touched unless explicitly provided.

**Rationale**: `PinnedSnapshotSchema` requires bullet `id` (`src/lib/generation/plan.ts:39`), Fact Guard indexes per-bullet text/provenance (`src/lib/generation/factguard.ts:43-53`), and the e2e suite documents that "bullet ids are rewritten on every bullet save" as a known hazard (`tests/e2e/support/editor.ts:1-7`). Snapshots are immutable, so id churn across *edits* is tolerated by history — but stable ids make bullet-level provenance meaningful for live content and remove the hazard class entirely. The `bullets` array stays part of the entry PATCH body (no new endpoints).

**Alternatives considered**:
- *Dedicated bullet CRUD endpoints* (`POST/PATCH/DELETE …/bullets/[id]`): rejected — more routes and contract churn for no user-visible gain; the UI already edits bullets as a set, and create-with-bullets must keep working for the seed path (`tests/e2e/scripts/seed.ts:139`).
- *Keep rewrite but copy ids*: rejected — delete+recreate still churns `id` (cuid is regenerated on create) and complicates provenance preservation for no benefit over a true diff.

## D3. Empty bullets: UI-local until they have text

**Decision**: "+ Bullet" appends a draft bullet that exists only in client state; the debounced bullets save sends only bullets with non-empty text (existing bullets keep their `id`). A draft is dropped if abandoned empty; once text is entered it is included in the next save and thereafter behaves like any bullet.

**Rationale**: `BulletInputSchema.text` requires `min(1)` (`src/lib/validation/schemas.ts:76`) and the spec's Assumptions fix this behavior: an empty bullet is not a server-side error, it is simply not yet content. This also removes today's failure mode where `+ Bullet` immediately PATCHes and the 400 is silently ignored (`src/components/profile/BulletEditor.tsx:59-61`).

**Alternatives considered**:
- *Relax server validation to allow empty bullets*: rejected — empty bullets would leak into snapshots, Fact Guard evidence, and exports.

## D4. "+ Add": client-side placeholder payloads, per section

**Decision**: `addEntry` (`src/app/profile/page.tsx:161-173`) sends a minimal valid payload for every section, generalizing the existing experience pattern (`{ company: "New role", title: "Title" }`): education → `{ institution: "New education" }`, skills → `{ name: "New skill" }`, languages → `{ name: "New language" }`, projects → `{ name: "New project" }`, certifications → `{ title: "New certification" }`. The server `CreateSchemas` are unchanged. Non-409 failures set the error state (today they are silently dropped, page.tsx:172).

**Rationale**: Satisfies the create schemas' required fields with sensible placeholders (spec Assumptions), keeps the create API contract untouched, and the new row is immediately editable in the UI.

**Alternatives considered**:
- *Server-side defaults for missing required fields on create*: rejected — changes the create contract consumed by `tests/e2e/scripts/seed.ts` and the integration suite, and hides invalid creates.
- *An inline "new entry" form instead of placeholder rows*: rejected — larger UX change than the spec asks for ("no redesign of the editor UX").

## D5. Clearing and parsing field values in the UI

**Decision**: `parseInput` (`src/app/profile/page.tsx:408-416`) maps: empty string → `null` for every optional scalar field (dates, location, degree, field, grade, proficiency, category, level, link, issueDate); `skillsUsed`/`aliases` keep the comma-split behavior, where an emptied input sends `[]`. Required fields (name/title/company/institution) send the raw string — emptying them produces a server `VALIDATION_ERROR` that is displayed (D7), not silently retried.

**Rationale**: The server already accepts `null` for every `.nullish()` optional (`src/lib/validation/schemas.ts`) — today's bug is purely client-side: an emptied date sends `""`, which fails `YearMonthSchema`'s regex (schemas.ts:20). Clearing must persist (spec FR-005).

**Alternatives considered**:
- *Coerce `""` to `null` in the schemas*: rejected — masks genuinely invalid payloads and diverges from the create path.

## D6. Provenance on edit: absent key means "no transition"

**Decision**: With D1 in place, an ordinary field edit never carries `provenance`, so `applyProvenanceTransition` is not invoked and imported/confirmed entries keep their origin and metadata (`reviewFlag`, `confidence`, `sourceDocumentId`, `sourceLocator`) — the spec's FR-003. Explicit transitions are unchanged: → `user_confirmed` (imported entries require an open `reviewFlag`; confirming clears it), and `imported` → `user_entered` (which still drops imported metadata — that remains the explicit "re-attribute to me" action via any payload that says so).

**Rationale**: Matches the integration suite's transition rules (`tests/integration/profile-editor.test.ts:141-197`) and removes the accidental de-import on edit (repository.ts:234-236 + 252-257).

**Alternatives considered**:
- *Block editing imported entries entirely until confirmed*: rejected — contradicts FR-003 (imported entries must remain editable with labels intact).
- *Strip metadata on edit of imported entries* (today's accidental behavior): rejected — destroys Fact Guard evidence; explicitly prohibited by the spec.

## D7. Error surfacing: one status surface, three outcomes, item context

**Decision**: The editor keeps a single save-status area (`data-testid="save-status"`, page.tsx:209-211) but it now renders three outcomes — `Saving…`, `Saved · vN`, `Failed: …` — plus a dedicated error line (`data-testid="save-error"`) and a non-blocking warning line (`data-testid="save-warning"`) shown after successful saves that return `warnings` (today the `warnings` array from POST/PATCH is read for `.version` only and discarded, page.tsx:153). Every fetch path — `patchProfile` (which today has no `else` at all, page.tsx:140-143), `saveEntry`, `addEntry`, `deleteEntry` — must handle non-OK responses by reading the error envelope (`{ error: { code, message, details } }`, `src/lib/api/errors.ts:85-110`) and prefixing the human item label (e.g., "Experience at Acme — company name cannot be empty" built from the section + entry title + zod issue path).

**Rationale**: The spec's FR-012/013/014/015/016 map 1:1 onto these surfaces; the envelope already carries per-issue zod paths, so no server change is needed for specificity.

**Alternatives considered**:
- *Per-field inline error text everywhere*: rejected for this pass — the envelope's issue list is enough to name the field in the banner; inline per-field decoration can come later without contract change.
- *Toasts*: rejected — new UI pattern; the status line is the established surface.

## D8. Basics saves: merge pending edits before flush (lost-update fix)

**Decision**: Basic-detail edits accumulate into a pending-basics ref; the debounced flush sends the merged pending object (`{ basics: { ...lastSent, ...pending } }`). The server keeps replacing `basics` wholesale (`updateBasics`, repository.ts:148-160). Additionally `patchProfile` gains the failure handling from D7.

**Rationale**: Today each keystroke schedules `patchProfile({ basics: { ...profile.basics, [key]: value } })` from render-time state (page.tsx:234-245); two quick edits on different fields can overwrite each other because the second patch is built from a stale copy — a real lost-update the spec's edge cases call out. Client-side merge fixes it without changing the server contract.

**Alternatives considered**:
- *Field-granular basics patch endpoints*: rejected — contract churn; wholesale basics replace is fine once patches are merged client-side.

## D9. Refetch strategy and in-flight edits

**Decision**: Keep the existing save-then-refetch (`await load()` after success) — no optimistic updates. Scalar field inputs stay uncontrolled (`defaultValue`), so a refetch never reverts what the user sees; the self-healing property is that the next keystroke re-sends that field's current value. Bullet editing is the one controlled surface, so `BulletEditor` keeps draft state locally (D3) and reconciles from props only when no unsaved draft exists, preventing a refetch from clobbering in-flight typing.

**Rationale**: Matches the existing architecture (documented in `tests/e2e/04-autosave-persistence.spec.ts`), minimizes diff, and satisfies FR-014 (a failed save leaves the typed value visible; reload shows the last saved state).

**Alternatives considered**:
- *Optimistic updates with rollback*: rejected — much larger change to state handling; the debounced 800 ms window is small and the current UX (network-level wait in e2e helpers) depends on refetch.
- *Stop refetching after saves*: rejected — version number, low-confidence counts, and provenance badges all refresh via `load()`.

## D10. Test strategy

**Decision**:
- **Integration (vitest)**: add cases for — field-only PATCH on an entry that has bullets (bullets, `order`, `skillsUsed` survive; bullet `id`s stable across a text edit); edit of an imported entry preserves provenance + metadata; edit of a `user_confirmed` entry succeeds; `startDate: null` clears, `startDate: ""` → 400; create with the D4 placeholder payload for every section; bullets diff (add/update/remove in one PATCH). Update the two cases that currently rely on defaulted-patch behavior.
- **E2E (playwright)**: `02-experience-crud` adds a bullet through the UI (API workaround at :47-53 removed); `03-sections-crud` adds entries through "+ Add" for all six sections (API workaround removed) and reaches the duplicate-skill dialog through the UI; `04-autosave-persistence` covers a cleared date and rapid successive edits to different fields of one entry; new assertions on `save-error` for a deliberate validation failure. `tests/e2e/support/editor.ts` `addBullet` simplifies: no PATCH is expected on "+ Bullet" click, only on the subsequent fill (D3).
- **Unit**: patch-schema strip-defaults test (absent keys stay absent; `null` passes for nullish fields; explicit `provenance` present).

**Rationale**: The existing suites already wait on network responses (no sleeps) and assert on bullet text/order rather than ids — they are ready to absorb the behavior change; the two documented-broken workarounds are the spec's SC-006.

**Alternatives considered**: none worth recording.

## D11. Compatibility verification (generation / Fact Guard / export)

**Decision**: No changes to `src/lib/generation/**` or the snapshot format. Verification is by test: the pinned-snapshot schema still validates every snapshot written by the new save paths (integration tests assert a post-edit snapshot parses and carries stable bullet ids), and the existing generation/factguard/render unit + e2e suites (`08-generation-views.spec.ts`) must pass unchanged.

**Rationale**: `PinnedSnapshotSchema` consumes `serializeProfile` output by entry/bullet id (`src/lib/generation/plan.ts:36-107`); D1/D2 keep every field it reads intact.

**Alternatives considered**: none — this is a constraint, not a choice.
