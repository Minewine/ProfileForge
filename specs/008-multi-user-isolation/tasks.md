---

description: "Task list for multi-user support with per-user isolation"
---

# Tasks: Multi-User Support with Per-User Isolation

**Input**: Design documents from `/specs/008-multi-user-isolation/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/ (auth-api.md, data-access-rules.md), quickstart.md

**Tests**: Included — the spec's success criteria require them (SC-003 automated isolation tests, SC-004 zero regressions incl. GUI flows, SC-005 migration verification). Test tasks are listed FIRST in each story phase and must FAIL (or be unrunnable) before their implementation lands.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Single Next.js app (App Router) at repo root: `src/app/**` (pages + `route.ts` handlers), `src/lib/**` (domain modules), `prisma/` (schema + migrations), `scripts/`, `tests/unit|integration` (vitest, node env, include `tests/**/*.test.ts`), `tests/e2e` (Playwright, numbered `NN-*.spec.ts`).

**Note on migrations**: data-model.md describes one logical migration; it is applied as TWO Prisma migrations for incremental delivery — `multi_user` (foundational: User, Session, ownership columns) and `per_user_settings` (US3: AppSettings per user). The `AppSettings` PK conversion MUST NOT land before its code wiring (T034) or the settings API breaks.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and shared error vocabulary

- [x] T001 [P] Add dependencies to package.json: `@node-rs/argon2` (runtime, Argon2id hashing) and `tsx` (devDep, to run `scripts/assign-owner.ts`); install and verify `node -e "require('@node-rs/argon2')"` loads
- [x] T002 [P] Add auth error codes to `ERROR_CODES` and `STATUS_BY_CODE` in src/lib/api/errors.ts: `UNAUTHENTICATED` (401), `INVALID_CREDENTIALS` (401), `EMAIL_TAKEN` (409) — per contracts/auth-api.md; reuse existing `VALIDATION_ERROR` and `NOT_FOUND` unchanged

**Checkpoint**: Dependencies installed; error vocabulary ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Auth framework (schema, password, session, guards) that US1–US4 all build on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Tests for the auth framework (write FIRST, must FAIL before T008–T010)

- [x] T003 [P] Unit tests for password hashing in tests/unit/auth-password.test.ts: hash→verify roundtrip succeeds; wrong password fails; hash is not reversible/contains no plaintext; different salts for identical passwords
- [x] T004 [P] Unit tests for sessions in tests/unit/auth-session.test.ts: created session stores only SHA-256 hash (raw token absent from DB row); validation succeeds within 30 days; expired session is rejected; sliding renewal extends when <15 days remain and re-issues a cookie; destroy deletes the row; unknown/invalid token rejected
- [x] T005 [P] Unit tests for guards in tests/unit/auth-guard.test.ts: `requireUser()` resolves the session user on valid cookie; throws/returns 401 `UNAUTHENTICATED` without cookie; `getCurrentUser()` returns null without cookie (mock `next/headers` cookies per vitest node env)

### Schema

- [x] T006 Extend prisma/schema.prisma per data-model.md: add `User` model (id cuid, email `@unique`, passwordHash, createdAt/updatedAt) and `Session` model (id cuid, tokenHash `@unique`, userId FK→User onDelete: Cascade + `@@index([userId])`, expiresAt, createdAt); add nullable `userId` FK→User (onDelete: Cascade, indexed) to `Profile`, `SourceDocument`, `JobAnalysis`, `LlmUsageLog` — NULL = quarantined; do NOT touch `AppSettings` in this migration
- [x] T007 Create and apply migration `npx prisma migrate dev --name multi_user` and regenerate the client; verify `User`/`Session` tables exist and existing rows have NULL owner columns

### Implementation

- [x] T008 [P] Implement Argon2id hash/verify in src/lib/auth/password.ts (`hashPassword`, `verifyPassword` using @node-rs/argon2; default cost params) — makes T003 pass
- [x] T009 [P] Implement DB sessions in src/lib/auth/session.ts per data-model.md: `createSession(userId)` (32 random bytes base64url, store SHA-256 hex, expiresAt = +30d, set cookie `pf_session` HttpOnly/SameSite=Lax/Secure-on-HTTPS/Path=/ via `await cookies()`), `validateSession()` (tokenHash lookup, expiry check, sliding renewal at <15d re-sets cookie), `destroySession()` (delete row + clear cookie) — makes T004 pass
- [x] T010 Implement guards in src/lib/auth/guard.ts: `getCurrentUser()` for server components (valid session → user row; else null) and `requireUser()` for route handlers (valid session → user; else respond 401 `{ error: { code: "UNAUTHENTICATED" } }`) — makes T005 pass; only these functions read the session cookie in production code

**Checkpoint**: Auth framework green (`npm test` — new unit tests pass, existing suite unaffected). User story implementation can now begin.

---

## Phase 3: User Story 1 - Register, Log In, and Reach a Private Workspace (Priority: P1) 🎯 MVP

**Goal**: Visitors register/sign in with email+password; signed-out visitors see only login/register and no app data or API data.

**Independent Test**: Register → land in empty workspace; logout; login again → workspace reachable; wrong password fails; logged-out page/API access is redirected/401. Verified by quickstart.md Scenarios 1–2.

### Tests for User Story 1 (write FIRST, must FAIL)

- [x] T011 [P] [US1] API contract tests for auth endpoints in tests/integration/auth-api.test.ts per contracts/auth-api.md: register 201 + `{user:{id,email}}` + cookie; duplicate email (case/whitespace variant) → 409 `EMAIL_TAKEN`; invalid password → 400 `VALIDATION_ERROR`; login wrong password AND unknown email → identical 401 `INVALID_CREDENTIALS` shape; login success 200 + cookie; logout 204 + cookie cleared + session row deleted; `GET /api/auth/session` 200 when signed in, 401 when not; response bodies never contain passwordHash
- [x] T012 [P] [US1] E2E spec tests/e2e/11-auth-flows.spec.ts: fresh context → `/` redirects to `/login`; register → lands in workspace with empty profile/upload/jobs; sign out → `/profile` redirects to `/login`; login with wrong password shows error, no session; login succeeds → nav shows email; direct `/api/profile` fetch while logged out returns 401 (assert via page.request)

### Implementation for User Story 1

- [x] T013 [US1] Implement `POST /api/auth/register` in src/app/api/auth/register/route.ts: zod validation (email shape, password ≥8), normalize email (trim+lowercase), Argon2id hash (T008), create User + Session (T009) in one flow, set cookie, 201 `{user:{id,email}}`; catch unique-index violation → 409 `EMAIL_TAKEN` (race-safe per contracts/auth-api.md)
- [x] T014 [US1] Implement `POST /api/auth/login` in src/app/api/auth/login/route.ts: normalize email, lookup user, `verifyPassword`; unknown email and wrong password return the SAME generic 401 `INVALID_CREDENTIALS` response; success creates Session + cookie, 200 `{user:{id,email}}`
- [x] T015 [P] [US1] Implement `POST /api/auth/logout` in src/app/api/auth/logout/route.ts: `destroySession()`, always 204 (idempotent, no/invalid cookie included)
- [x] T016 [P] [US1] Implement `GET /api/auth/session` in src/app/api/auth/session/route.ts: 200 `{user:{id,email}}` or 401 `UNAUTHENTICATED`
- [x] T017 [US1] Create login page src/app/login/page.tsx: client form (email, password) posting to `/api/auth/login`, inline error display for `INVALID_CREDENTIALS`/`VALIDATION_ERROR`, link to `/register`, redirect to `/profile` on success; redirect already-authed visitors to `/profile` (server check with `getCurrentUser()`)
- [x] T018 [US1] Create register page src/app/register/page.tsx: client form posting `/api/auth/register`, show `EMAIL_TAKEN` and password-rule errors, link to `/login`, redirect to `/profile` on success; redirect already-authed visitors to `/profile`
- [x] T019 [US1] Create src/proxy.ts (Next 16; middleware.ts is deprecated — see research R8): cookie-PRESENCE check only — no `pf_session` cookie + protected page path (`/`, `/profile`, `/upload`, `/jobs`, `/settings` and subpaths) → redirect `/login`; never touch `/api/**`, `/login`, `/register`, `/_next`; matcher config per bundled docs
- [x] T020 [US1] Gate all existing pages with `getCurrentUser()` → `redirect("/login")` when null: src/app/page.tsx, src/app/profile/page.tsx, src/app/upload/page.tsx, src/app/jobs/page.tsx, src/app/jobs/[id]/page.tsx, src/app/settings/page.tsx (real session validation, not just proxy presence check)
- [x] T021 [US1] Add `requireUser()` as the first statement of every existing API route handler (all `route.ts` under src/app/api except `api/auth/**`): cv (upload, [id], [id]/parse), jobs (list, [id], extract/confirm/match/requirements/rerun), generations (list, [id], cancel/retry/download/document, claims, claim confirm, omissions restore), profile (root, import, versions, versions restore, entries [section], entries [section]/[id]), settings (root, models, validate-key), validation/claims → 401 `UNAUTHENTICATED` before any logic
- [x] T022 [US1] Add signed-in identity to the app header: locate the existing nav/header component under src/components/ and show the current user's email plus a Sign out button (POST `/api/auth/logout` then router push `/login`); keep existing nav links unchanged

**Checkpoint**: User Story 1 fully functional and independently testable (quickstart Scenarios 1–2 pass). NOTE: at this checkpoint all data is still effectively shared between signed-in users — isolation lands in US2.

---

## Phase 4: User Story 2 - Each User Sees Only Their Own Data (Priority: P1)

**Goal**: Every listing and direct access is scoped to the signed-in user; cross-account access behaves as NOT_FOUND; quarantined rows visible to nobody.

**Independent Test**: Two accounts A and B; A creates data; B lists (sees none) and requests A's ids (NOT_FOUND); A retains full access. Verified by quickstart.md Scenario 3.

### Tests for User Story 2 (write FIRST, must FAIL)

- [x] T023 [P] [US2] Integration tests for ownership scoping in tests/integration/ownership-scoping.test.ts per contracts/data-access-rules.md: for each root (Profile, SourceDocument, JobAnalysis, GenerationJob-via-analysis) — user B's read/update/delete of user A's id behaves as NOT_FOUND (not 403); B's list endpoints exclude A's rows; rows with `userId: null` match NO user's queries (quarantine); A retains full CRUD; new rows created via API are stamped with the creating user
- [x] T024 [P] [US2] E2E spec tests/e2e/12-multi-user-isolation.spec.ts: two browser contexts — A uploads CV + creates job + generates document; B sees empty lists; B opens A's `/jobs/<id>` → not-found behavior, never content; B calls `/api/jobs/<A's id>` and `/api/generations/<A's id>/document` → 404 `NOT_FOUND`; logout/login as A shows all data intact (covers SC-003)

### Implementation for User Story 2

- [x] T025 [P] [US2] Scope profile access by owner in src/lib/profile/repository.ts: replace the global `findFirst()` (line ~59) with `findFirst({ where: { userId } })`; every get-by-id/entry/version mutation resolves its row through the owning profile (`{ id, userId }` at the root, per data-model.md children get no column); thread `userId` from `requireUser()` through src/app/api/profile/** routes (root, import, versions, versions/[version]/restore, entries/[section], entries/[section]/[id])
- [x] T026 [P] [US2] Scope source documents (CVs) by owner: upload stamps `userId` on the created `SourceDocument` (src/app/api/cv/upload/route.ts + its lib in src/lib/files/ or src/lib/parsing/); `[id]` and `[id]/parse` lookups use `findFirst({ id, userId })` → NOT_FOUND else; `storagePath` never leaves the server (src/app/api/cv/**)
- [x] T027 [P] [US2] Scope job analyses by owner in src/lib/jobs/** and src/app/api/jobs/**: list filters `{ userId }`; by-id lookups `findFirst({ id, userId })` → NOT_FOUND; created analyses stamped with current user (root, extract, confirm, match, requirements, rerun)
- [x] T028 [P] [US2] Scope generations through their analysis in src/lib/generation/** and src/app/api/generations/**: every GenerationJob/GeneratedDocument/GeneratedDocumentVersion lookup joins `analysis.userId` = current user → else NOT_FOUND; applies to list, [id], cancel, retry, download (artifacts served only after this check), document, claims + claim confirm, omissions restore
- [x] T029 [P] [US2] Scope validation/claims in src/app/api/validation/claims/route.ts (and src/lib/validation/** helpers): the named document/version must resolve through an analysis owned by the current user → else NOT_FOUND
- [x] T030 [US2] Invariant sweep per contracts/data-access-rules.md invariant 1: grep production code (src/, excluding src/generated/) for unscoped `profile.findFirst()` and `appSettings.findUnique({ id: "singleton" })` reads — remove or scope every hit; `npm run lint` and `npm test` green

**Checkpoint**: User Stories 1 AND 2 both work; isolation provable (quickstart Scenario 3, SC-003 evidence).

---

## Phase 5: User Story 3 - Per-User OpenRouter Key and Settings (Priority: P2)

**Goal**: Each user has their own encrypted key, model prefs, cost cap; usage attributed per user; plaintext never exposed.

**Independent Test**: A and B set different keys/caps; each generation uses its owner's key/cap; neither can read any key in plaintext. Verified by quickstart.md Scenario 4.

### Tests for User Story 3 (write FIRST, must FAIL)

- [x] T031 [P] [US3] Integration tests in tests/integration/per-user-settings.test.ts: each user gets an independent settings row (default models/cap); saving a key stores only the encrypted `v1.<iv>.<tag>.<ct>` payload + hint (plaintext absent from DB and from any API response); cost-cap enforcement and LlmUsageLog rows aggregate per userId, not globally (A hitting the cap does not block B); key validation endpoint validates the caller's own key only

### Implementation for User Story 3

- [x] T032 [US3] Create and apply migration `npx prisma migrate dev --name per_user_settings`: convert `AppSettings` PK from `id "singleton"` to `userId String @id` (FK→User, onDelete: Cascade); existing singleton row keeps a NULL `userId` → quarantined until claimed (US4); regenerate client
- [x] T033 [US3] Make settings per-user in src/lib/settings/keyStore.ts and src/lib/settings/store.ts: read/write by `userId` instead of `{ id: "singleton" }`; all callers (settings routes in src/app/api/settings/**, LLM call sites) pass the current user from `requireUser()`/`getCurrentUser()`; encryption format in src/lib/settings/crypto.ts is unchanged (FR-007)
- [x] T034 [US3] Attribute LLM usage per user in src/lib/llm/**: stamp `LlmUsageLog.userId` on every call; the cost-cap check aggregates usage by the current user's id (FR-008); cap-reached errors unchanged (`COST_CAP_REACHED`)
- [x] T035 [US3] Wire settings routes to the signed-in user in src/app/api/settings/** (root, models, validate-key): responses unchanged in shape for the owner; ensure decrypted key exists only in server memory and never in responses/logs (hint only)

**Checkpoint**: All P1/P2 stories functional; quickstart Scenario 4 passes.

---

## Phase 6: User Story 4 - Existing Single-User Data Is Migrated or Quarantined (Priority: P2)

**Goal**: Pre-feature data is claimable by one designated owner; invisible to everyone until claimed.

**Independent Test**: On a DB with pre-feature rows, run the claim script for `owner@example.com`; owner sees and can use all legacy data; another account sees none; re-run is a no-op. Verified by quickstart.md Scenario 5.

### Tests for User Story 4 (write FIRST, must FAIL)

- [x] T036 [P] [US4] Integration tests for the claim script in tests/integration/assign-owner.test.ts: creates the owner when absent (hashed password verifiable); assigns userId to ALL quarantined Profile/SourceDocument/JobAnalysis/LlmUsageLog/AppSettings rows in one run; second run changes nothing (idempotent); quarantined rows were invisible to other users before the claim and remain invisible after

### Implementation for User Story 4

- [x] T037 [US4] Implement scripts/assign-owner.ts (`npx tsx scripts/assign-owner.ts --email <owner>`): parse/normalize email, create-or-lookup the User (prompt for password ≥8 via readline when creating, hash with T008), then in ONE transaction set `userId` on every NULL-owner Profile, SourceDocument, JobAnalysis, LlmUsageLog, and the legacy AppSettings row; print a summary count; exit non-zero on failure; add `"db:assign-owner": "tsx scripts/assign-owner.ts"` to package.json scripts
- [x] T038 [US4] Update tests/e2e/scripts/reset-db.mjs to support the multi-user world: seed legacy rows with NULL `userId` where a scenario needs quarantined data, and provide two test users (owner/other) so isolation specs (T024, T039) are deterministic
- [x] T039 [US4] E2E spec tests/e2e/13-legacy-data-claim.spec.ts: with reset-db-seeded quarantined rows, run the claim script (exec in test setup), then owner logs in and sees/uses all legacy data; `other` logs in and sees none; direct legacy ids → NOT_FOUND (covers SC-005)

**Checkpoint**: All user stories complete; quickstart Scenario 5 passes.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Regression proof, security sweep, docs

- [x] T040 [P] Update README.md: registration/login usage, the assign-owner migration step for existing installations, and the `pf_session`/`APP_SECRET` deployment notes (existing `.appsecret` continues to encrypt per-user keys)
- [x] T041 Security sweep across src/lib/** and src/app/api/**: no passwordHash, raw session tokens, or decrypted keys in any response body, server log statement, or error message (FR-013, SC-006); add a regression assertion for this to tests/integration/auth-api.test.ts if not already covered by T011
- [x] T042 Run the FULL suites and fix regressions until green (SC-004): `npm test` (vitest) and `npm run test:e2e` (Playwright incl. existing specs 01–10 which must pass unchanged against the authed flows — update their setup to sign in first if needed, without weakening assertions)
- [x] T043 Execute quickstart.md Scenarios 1–6 end-to-end and record results (SC-001–SC-006 evidence); fix any gap found and re-run the affected scenario

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: depends on Foundational; blocks nothing (US2–US4 can start after Foundational in principle, but US2's route scoping builds on US1's `requireUser()` wiring (T021), so run US1 → US2)
- **US2 (Phase 4)**: depends on US1 (guards wired into routes/pages)
- **US3 (Phase 5)**: depends on US2 (settings routes already authed + scoped); its migration (T032) MUST follow the foundational migration
- **US4 (Phase 6)**: depends on US3 (claims the AppSettings row created by T032) and Foundational (User/password for owner creation)
- **Polish (Phase 7)**: depends on all stories

### User Story Dependencies

- **US1**: Foundational only. Independently testable (auth flows work even while data is still shared).
- **US2**: US1's guard wiring. Independently testable (two-user isolation without touching settings internals).
- **US3**: US2. Independently testable (per-user keys/caps with two accounts).
- **US4**: US3 + Foundational. Independently testable (claim script against quarantined rows).

### Within Each User Story

Tests first (must fail) → schema/migration (US3) → lib implementation → route/page wiring → checkpoint validation via quickstart scenarios.

### Parallel Opportunities

- T001, T002 (Setup) in parallel
- T003–T005 (framework tests) in parallel; T008–T009 in parallel; T010 after T009
- Within each story: the test tasks (marked [P]) in parallel; T013–T016 endpoints: T015/T016 parallel after T009; T025–T029 (US2 domain scoping) fully parallel — different lib/route trees
- T036 test parallel with T037 script authoring is NOT allowed (test must fail first) — write test, watch it fail, then implement

---

## Parallel Example: User Story 2

```bash
# All five domain-scoping tasks touch disjoint file trees (after T023/T024 exist):
Task: "Scope profile access by owner in src/lib/profile/repository.ts + src/app/api/profile/**"
Task: "Scope source documents (CVs) by owner in src/app/api/cv/** + src/lib/files|parsing"
Task: "Scope job analyses by owner in src/lib/jobs/** + src/app/api/jobs/**"
Task: "Scope generations through their analysis in src/lib/generation/** + src/app/api/generations/**"
Task: "Scope validation/claims in src/app/api/validation/claims/route.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational (CRITICAL — blocks all stories)
2. Phase 3 US1 → **STOP and VALIDATE**: quickstart Scenarios 1–2 (register/login/lockout works; data still shared internally)
3. Deploy/demo if ready — but do NOT ship multi-user without US2 (isolation is the safety property)

### Incremental Delivery

1. Setup + Foundational → framework green
2. US1 → validate (auth gate) → US2 → validate (isolation; this is the first shippable multi-user state)
3. US3 → validate (per-user billing) → US4 → validate (legacy claim)
4. Polish: full suites + quickstart as the final gate

### Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to spec user story for traceability
- Commit after each task or logical group (Conventional Commits per workspace instructions — only when asked)
- Stop at any checkpoint to validate the story independently
- Avoid: weakening existing e2e specs (01–10) to make T042 pass — adapt setup, keep assertions
