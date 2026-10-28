# Quickstart: Validating Multi-User Support End-to-End

Feature: `008-multi-user-isolation` · Date: 2026-10-26

Runnable scenarios proving the feature works. Reference [contracts/auth-api.md](./contracts/auth-api.md) and [contracts/data-access-rules.md](./contracts/data-access-rules.md) for exact status codes and rules; [data-model.md](./data-model.md) for schema. Implementation detail lives in `tasks.md`.

## Prerequisites

- Docker (for PostgreSQL) and Node.js installed; dependencies installed (`npm install`).
- Database up: `npm run db:up` — then apply migrations: `npm run db:migrate` (creates `User`, `Session`, ownership columns).
- **New dependency**: `@node-rs/argon2` must be installed.

## Scenario 1 — Register, land in a private empty workspace (SC-001)

1. `npm run dev`; open `http://localhost:3000` in a fresh browser profile.
2. **Expect**: redirect to `/login`; no app data anywhere.
3. Go to `/register`; register `owner@example.com` with a password ≥ 8 chars.
4. **Expect**: signed in automatically, land in the workspace; profile/upload/jobs are all empty — nothing from the pre-existing single-user data (it is quarantined until claimed).

## Scenario 2 — Logged-out lockout (FR-004)

1. Sign out (nav button).
2. Open `/profile`, `/jobs`, `/settings` directly, and `curl -i http://localhost:3000/api/profile`.
3. **Expect**: pages redirect to `/login`; the API returns `401` with code `UNAUTHENTICATED` — never data.

## Scenario 3 — Two-user isolation (SC-003, the core check)

1. In browser profile A: sign in as `owner@example.com`, upload a CV, create a job analysis, generate a document. Note the URLs/ids (e.g. `/jobs/<id>`).
2. In browser profile B (or incognito): register `other@example.com`.
3. **Expect**: B's lists (jobs, uploads, documents, profile) show nothing of A's; opening A's `/jobs/<id>` URL as B behaves as "not found" (error/redirect, never content); B's `/api/jobs/<A's id>` returns `NOT_FOUND`.
4. Sign B out; sign in as A again — all of A's data is intact (FR-002/FR-003).

## Scenario 4 — Per-user key and settings (FR-007/FR-008)

1. As A: save an OpenRouter key in `/settings`; note the hint shown.
2. As B: open `/settings` — no key configured; B saves a **different** key.
3. As A: run a generation — it uses A's key and A's cost cap; usage is attributed to A only.
4. **Expect**: neither user can retrieve any key in plaintext (only hints); responses/logs contain no secrets (spot-check server logs).

## Scenario 5 — Claiming the legacy single-user data (FR-009, SC-005)

1. Before any registration (fresh DB restored from a pre-feature dump, or a DB containing pre-feature rows): run
   `npx tsx scripts/assign-owner.ts --email owner@example.com`
   (creates the owner if absent; prompts for a password if creating).
2. Sign in as `owner@example.com`.
3. **Expect**: all pre-existing profile data, uploaded CVs, job analyses/match reports, and generated documents are present and fully usable (open, edit, regenerate, download).
4. Sign in as `other@example.com` — none of the legacy data appears; direct legacy ids return `NOT_FOUND`.
5. Re-run the script — idempotent, claims nothing further.

## Scenario 6 — Feature parity for a signed-in user (SC-004)

1. As the signed-in owner, exercise each existing flow once: CV upload + parse (both languages), profile edit + version restore, JD analysis → confirm requirements → match, CV generation + cover-letter generation, claim confirmation / omission restore (Fact Guard), document download, template selection.
2. **Expect**: identical behavior to the pre-feature app (same pages, same results, same error handling).
3. Run the automated suites — all green:
   - `npm test` (vitest unit/integration, incl. new auth + ownership tests)
   - `npm run test:e2e` (Playwright; includes the new two-user isolation flows)

## Failure triage

| Symptom | Likely cause | Where to look |
|---|---|---|
| Logged-out user sees app data | Guard missing on a route/page | [data-access-rules.md](./contracts/data-access-rules.md) Layer 1; the route's first lines |
| B gets content for A's resource id | Lookup missing `userId` predicate | [data-access-rules.md](./contracts/data-access-rules.md) Layer 2; the lib function fetching the root |
| `500` on settings save | Settings lookup still keyed by `"singleton"` | `src/lib/settings/store.ts`, `keyStore.ts` |
| Legacy data invisible to owner | Claim script not run / wrong email | `scripts/assign-owner.ts` output; Scenario 5 |
| Login always fails after restart | Session rows wiped (reset-db) or secret change | `tests/e2e/scripts/reset-db.mjs`; `.appsecret`/`APP_SECRET` stability |
