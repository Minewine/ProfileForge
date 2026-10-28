# Quickstart: Validate Fix Profile Editor CRUD

**Feature**: `specs/007-fix-profile-editor-crud` | **Date**: 2026-10-26

How to prove the spec end to end: automated suites first, then a manual walkthrough of the five user stories. Artifacts referenced: [contracts/api.md](./contracts/api.md), [contracts/editor-ui.md](./contracts/editor-ui.md), [data-model.md](./data-model.md), [../research.md](../research.md).

## Prerequisites

- Docker (for PostgreSQL) and Node.js installed (repo pins no Node version).
- Dependencies installed: `npm install`
- Playwright browser (once): `npm run e2e:install`

## Run the automated suites

```bash
# Unit + integration (integration boots route handlers directly; needs the dev DB)
npm run db:up        # docker compose up -d
npm run db:migrate   # prisma migrate dev
npm test             # vitest run

# End-to-end (isolated e2e DB on :5434, production build on :3100, seeded)
npm run test:e2e     # docker compose e2e-db + reset-db.mjs + playwright test
```

Expected: all suites pass, including the previously documented-broken scenarios —

- `tests/e2e/02-experience-crud.spec.ts` adds a bullet **through the UI** (no API workaround).
- `tests/e2e/03-sections-crud.spec.ts` adds entries **through "+ Add"** for all six sections (no API workaround) and reaches the duplicate-skill dialog through the UI.
- All generation / Fact Guard / template-export / version-history suites pass unchanged (SC-006).

Key new coverage: field-only PATCH on an entry with bullets preserves bullets (SC-002, stable bullet ids); edit of a confirmed entry succeeds; cleared date persists; rapid successive edits both persist; every failure mode surfaces `save-error` (SC-003).

## Manual walkthrough (maps to spec user stories)

Start the app: `npm run dev` → http://localhost:3000/profile (seed a profile first via the upload/import flow or the e2e seed script if the profile is empty).

**US1 — Edit and persist.** Change a company name on an entry that has bullets; within ~2s `save-status` shows `Saved · v{N+1}`. Reload: new name shown, **both bullets still there** (SC-002). Edit a field on an entry you previously *Confirm*ed — no error. Reword a bullet; reload; reworded text persists. Change your name in Basics; reload; persisted.

**US2 — Add everywhere.** In each section (including an empty one) click `+ Add`: a new editable row appears immediately (placeholder content). Fill it in; reload; it persisted. On an experience entry click `+ Bullet`, type text while watching: text does **not** revert; reload; bullet persists. Click `+ Add` in Skills with an existing skill name → duplicate-skill dialog appears, nothing created.

**US3 — Remove.** Delete an entry in two different sections; reload; gone, others intact. Remove one bullet of three; reload; only that one is gone. Delete the last entry of a section → empty state, `+ Add` still works.

**US4 — Feedback.** Clear the Basics *Name* field → `save-error` shows a specific message (`Profile basics — …`); the field is not silently reverted; reload shows the last saved name. Type an invalid email → same. Stop the dev server's DB (`docker compose stop db`) and edit something → `Failed — could not reach the server`. Restart the DB and edit → recovers, `Saved · v{N+1}`. Give an experience the same dates as another → `save-warning` shows `DATE_RANGE_OVERLAP…` **and** the save still succeeds.

**US5 — Downstream.** After the edits above: generate a CV for a job (succeeds, reflects edits), check Fact Guard results against the edited bullets, run template export (renders edited content), open version history (every change recorded), restore an older version and edit one of its entries (saves like live content).

## Pass criteria

Spec success criteria SC-001..SC-007 are all observable through the steps above; the automated suites are the authoritative check (see `spec.md` → Success Criteria).
