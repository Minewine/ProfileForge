# Implementation Plan: Fix Profile Editor CRUD

**Branch**: `007-fix-profile-editor-crud` | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-fix-profile-editor-crud/spec.md`

## Summary

Fix the `/profile` editor so every save path works end to end. Server-side entry updates become strict partial patches — only the fields actually sent are applied, so bullets, list order, array fields, and provenance metadata are no longer clobbered by schema defaults (today a single field edit deletes the entry's bullets and rejects edits to confirmed entries). Bullet saves switch from delete-and-recreate to an id-preserving sync, so existing bullet rows and their Fact Guard provenance survive edits. "+ Add" works in all six sections via client-side placeholder payloads; a new bullet stays local until it has text; cleared optional fields save as `null`; and every failed save (validation, server, network) shows a visible, specific error including the item involved. Generation, Fact Guard, template export, version snapshots, and the profile DTO shape are unchanged.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Next.js 16.4.2 (App Router, `cacheComponents: true`), React 19.3, Node.js (repo pins no `engines`/`.nvmrc`)

**Primary Dependencies**: Prisma 7.10 + `@prisma/adapter-pg` (client generated at `src/generated/prisma`), zod 4.6.7, local UI primitives in `src/components/ui` (Button, Textarea, Dialog), Vitest 4, Playwright 1.64

**Storage**: PostgreSQL via `docker-compose.yml` (dev database; separate `e2e-db` service on port 5434 for Playwright)

**Testing**: `npm test` → Vitest run (unit + integration; integration tests import route handlers directly). `npm run test:e2e` → docker compose `e2e-db` + `tests/e2e/scripts/reset-db.mjs` + Playwright (workers=1, production build on :3100, seeded by `tests/e2e/scripts/seed.ts`)

**Target Platform**: Web, single-user local application (Playwright drives chromium)

**Project Type**: Full-stack web app — one editor page (`src/app/profile/page.tsx`, client component) plus JSON route handlers under `src/app/api/profile/`

**Performance Goals**: An autosaved change is persisted on the server within ~2s of the user's last keystroke (spec SC-004); a failed save shows visible feedback within ~2s (SC-003). The existing 800 ms per-target debounce (`AUTOSAVE_DELAY_MS`, page.tsx:95) is retained.

**Constraints**:
- `serializeProfile` DTO shape and `ProfileSnapshot.data` must remain valid for `PinnedSnapshotSchema` (`src/lib/generation/plan.ts:36-107`) — entry and bullet `id` are **required** there; generation, Fact Guard, and template export read pinned snapshots by id.
- Every mutation must keep bumping `Profile.version` and writing a full snapshot (`commitMutation`, repository.ts:127-141) — version history behavior is part of the contract.
- Next.js 16 route conventions: dynamic `params` are a Promise that must be awaited; handlers are uncached by default (already complied with).
- Prisma schema must not change (no migration); the fix is behavioral.

**Scale/Scope**: One profile, six sections, one editor page, five API routes, three profile components. Bug fix — no new pages, no schema migration, no new dependencies.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the un-ratified template (placeholder principle names only — no project principles have been adopted). There are no defined gates to evaluate, so the check is vacuously **PASS**.

Post-Phase-1 re-check: unchanged. The design adds no new structural complexity (no new projects, services, or dependencies — see empty Complexity Tracking) and reuses the existing stack, repository pattern, error envelope, and test harness.

## Project Structure

### Documentation (this feature)

```text
specs/007-fix-profile-editor-crud/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
│   ├── api.md           # HTTP contract: profile + entries endpoints, strict-patch semantics
│   └── editor-ui.md     # Editor UI contract: save flow, status/error/warning surfaces, testids
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
src/
├── app/
│   ├── profile/page.tsx                        # editor page (client) — save paths, add/remove, error surfacing, date/array parsing
│   └── api/profile/
│       ├── route.ts                            # GET profile, PATCH basics  (PATCH error handling added)
│       ├── entries/[section]/route.ts          # POST create entry          (unchanged shape)
│       ├── entries/[section]/[id]/route.ts     # PATCH strict partial update, DELETE entry (validation change)
│       ├── versions/…                          # untouched
│       └── import/…                            # untouched
├── components/profile/
│   ├── BulletEditor.tsx                        # local draft for empty bullets; id-stable change events
│   ├── MergeOrKeepDialog.tsx                   # duplicate-skill dialog (kept as-is)
│   └── ProvenanceBadge.tsx                     # untouched
├── lib/
│   ├── api/errors.ts                           # error envelope (unchanged; UI now surfaces it everywhere)
│   ├── profile/
│   │   ├── repository.ts                       # updateEntry: defaults-free patch handling, id-preserving bullet sync
│   │   └── sectionSchemas.ts                   # strict partial PatchSchemas (defaults stripped); CreateSchemas unchanged
│   ├── validation/schemas.ts                   # defaults-free patch variants of section input schemas
│   └── generation/                             # consumers (plan.ts, factguard.ts, render/cv.ts) — MUST remain untouched
└── types/index.ts                              # re-exports validation schemas (unchanged)
prisma/schema.prisma                            # unchanged — no migration
tests/
├── integration/profile-editor.test.ts          # new cases: partial-patch semantics, bullet id stability, null-clears
├── integration/profile-repository.test.ts      # provenance-on-edit expectations updated
├── e2e/
│   ├── 02-experience-crud.spec.ts              # bullet add via UI (API workaround removed)
│   ├── 03-sections-crud.spec.ts                # "+ Add" via UI for all sections (API workaround removed)
│   ├── 04-autosave-persistence.spec.ts         # extended: cleared date, rapid field edits
│   └── support/editor.ts                       # addBullet helper: no PATCH expected on "+ Bullet" click
└── unit/                                       # patch-schema strip-defaults test
```

**Structure Decision**: Bug fix in place — no new top-level directories, no schema migration, no new dependencies. Changes are confined to the editor page and profile components, the profile validation/repository layers, and their tests. Any new file (e.g., a shared save-status component) stays within `src/lib/profile/` or `src/components/profile/`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

Empty — no constitution violations (constitution un-ratified) and no structural complexity added.
