# Phase 0 Research: Multi-User Support with Per-User Isolation

Feature: `008-multi-user-isolation` · Date: 2026-10-26

## R1: Auth method — email+password vs. magic link

**Decision**: Email + password.

**Rationale**: Magic-link login requires an email-delivery service (SMTP server or transactional-email provider) — new infrastructure, credentials, and deliverability concerns that contradict the spec's MVP-simplicity constraint and the local/self-hosted deployment model. Password auth needs only a hash library and a session store we already have (PostgreSQL). The spec (FR-001) explicitly allows either; the assumptions section already favored password.

**Alternatives considered**: Magic link (rejected: email infrastructure); OAuth social login (rejected: out of scope, needs provider accounts); passkeys (rejected: complexity, no requirement).

## R2: Build minimal custom auth vs. adopt an auth library

**Decision**: Minimal custom implementation (password hashing + DB-backed opaque session tokens), following the pattern in the bundled Next.js 16 guide (`node_modules/next/dist/docs/01-app/02-guides/authentication.md`).

**Rationale**: The app needs exactly two capabilities — credential verification and session persistence. A custom implementation is ~3 small modules (`password.ts`, `session.ts`, `guard.ts`) using the Prisma client and node crypto already present; it is fully auditable and has zero new conceptual surface (no providers, adapters, callbacks, or JWT config). The Next.js guide itself documents this database-session pattern in detail. Per workspace AGENTS.md, Next-16-specific conventions were verified from the bundled docs: `middleware.ts` is deprecated and renamed `proxy.ts` (file at `src/proxy.ts`, one per project, for optimistic checks only — not an authorization boundary), and `cookies()` is async (`await cookies()`).

**Alternatives considered**: Auth.js/NextAuth v5 (rejected: designed around OAuth providers; credentials provider is awkward in App Router and its session/JWT machinery is surplus for one credential type); Better Auth (rejected: newer, larger API surface than needed); iron-session (rejected: stateless cookie sessions complicate revocation — logout should invalidate server-side — and store session data client-side; DB sessions are equally simple here since Prisma is already in every code path).

## R3: Password hashing

**Decision**: `@node-rs/argon2` (Argon2id), default cost parameters.

**Rationale**: Argon2id is the current standard recommendation for password storage (memory-hard). `@node-rs/argon2` ships prebuilt NAPI binaries (no compile step) and a small API (`hash`, `verify`).

**Alternatives considered**: `bcryptjs` (pure JS, no native dep, but bcrypt is weaker against GPU attacks and slower); `scrypt` via node:crypto (viable, but hand-rolling hashing params/format is more error-prone than a purpose-built library; note the existing `crypto.ts` uses scrypt only for key derivation from the app secret, which stays as-is).

## R4: Session design

**Decision**: DB-backed opaque tokens. On login/register: generate 32 random bytes (base64url) → set cookie `pf_session` (HTTP-only, SameSite=Lax, Secure when HTTPS, Path=/, 30-day Max-Age) → store only SHA-256(token) hex in a `Session` row with `expiresAt = now + 30 days`. On each request: read cookie, hash, `session.findUnique({ tokenHash })` where `expiresAt > now`, join user. Sliding renewal: if <15 days remain, extend and refresh the cookie. Logout: delete the row, clear the cookie.

**Rationale**: Opaque tokens leak nothing if the DB is read; storing only the hash means a DB dump cannot be replayed as sessions; DB rows give instant revocation and simple expiry. 30-day persistence matches the spec assumption (FR-003, "generous period"). SHA-256 is sufficient because the token is high-entropy (no need for a slow KDF).

**Alternatives considered**: JWT/stateless cookie (rejected: no server-side revocation; secret rotation burden); signed session cookie via iron-session (see R2).

## R5: Where ownership is enforced (the key design decision)

**Decision**: Scope ownership at the **root entities only** — `Profile`, `SourceDocument`, `JobAnalysis` — plus `AppSettings` (per user) and `LlmUsageLog` (attribution). Children (Experience, Education, Skill, LanguageSkill, Project, Certification, Bullet, ProfileSnapshot, JobRequirement, GenerationJob, GeneratedDocument, GeneratedDocumentVersion) are *never* fetched except through their root; they gain no column.

**Rationale**: The existing schema is strictly hierarchical: bullets hang off Experience/Project/Education → Profile; requirements/generations/documents hang off JobAnalysis. Every existing lib entry point already resolves a root by id (`repository.ts:74` `findUniqueOrThrow({ where: { id } })`, `repository.ts:59` `findFirst()`); changing those lookups to `{ id, userId }` (or `findFirst({ id, userId })`) closes all access paths with 4 columns instead of ~15. This also matches how `AppSettings` is already read (`keyStore.ts:12`).

**Alternatives considered**: `userId` on every table (rejected: redundant writes, no additional safety given the hierarchy); row-level security in PostgreSQL (rejected: extra infra complexity; app-level scoping is the established pattern here); a policy/ACL abstraction layer (rejected: over-engineering for one role).

## R6: Migration strategy for existing single-user data

**Decision**: Quarantine-by-default + claim script. The migration adds nullable `userId` columns. Existing rows get `NULL` → visible to nobody (queries always filter `userId = <current>`; `NULL` never matches). A one-time script `scripts/assign-owner.ts --email <owner>` creates the owner account (prompting for a password) or uses an existing one, then claims all owner-less rows in one transaction. The script is idempotent and safe to re-run.

**Rationale**: A migration cannot know the owner's email (the user registers *after* deploying this change), so hard ownership cannot be assigned at migration time without inventing placeholder accounts. Nullable columns + always-scoped queries give the spec's "cleanly separated" guarantee (FR-009: pre-existing data is never visible to other accounts; US4-3 quarantine semantics) with zero extra machinery. Tightening to `NOT NULL` can be a follow-up migration once every deployment has claimed its data.

**Alternatives considered**: Backfill at migration time to a first-registered user via trigger (rejected: magic behavior, order-dependent); dropping old data (rejected: spec requires the owner regains full access); keeping a separate legacy schema (rejected: doubles every query).

## R7: Per-user settings and cost cap

**Decision**: Repurpose `AppSettings` from `id "singleton"` to `userId @id` (one row per user, FK to User, cascade delete). `keyStore.ts`/`store.ts` read/write the signed-in user's row. `LlmUsageLog` gains nullable `userId` + index; the cost-cap check sums usage for the current user. Key encryption is unchanged (`crypto.ts` AES-256-GCM with `APP_SECRET`/`.appsecret` — per-user rows, same app-level key, as the spec requires "stored encrypted, as today").

**Rationale**: Smallest possible change to existing call sites (same functions, new lookup key). Reusing the existing encrypted format avoids a re-encryption migration of the existing key.

**Alternatives considered**: New `UserSettings` table + deprecate `AppSettings` (rejected: duplicates a table and forces migrating the existing encrypted key row); per-user encryption subkeys (rejected: complexity with no spec requirement).

## R8: Unauthenticated gating — proxy vs. per-route guards

**Decision**: Both, with a strict division: `src/proxy.ts` redirects unauthenticated **page** requests to `/login` based on cookie *presence* only (optimistic, per Next 16 docs); real enforcement — session validation, 401 for data APIs, redirect for stale/invalid cookies — lives in `guard.ts` (`getCurrentUser()` for server components, `requireUser()` for route handlers), called by every page and route handler.

**Rationale**: The Next.js 16 docs explicitly state proxy "is not intended to be a full session management or authorization solution" and cannot query the DB (edge runtime); cookie-presence checks are the documented optimistic pattern. Authorization must therefore be enforced at the data layer anyway, so the proxy is purely UX (avoid flashing the app shell to logged-out visitors).

**Alternatives considered**: Proxy-only gating (rejected: not a security boundary); layout-level guard only (rejected: API routes bypass layouts); per-route boilerplate without a guard module (rejected: 28 routes, error-prone).

## R9: UI shape for auth

**Decision**: Two new pages `/login` and `/register` (client components posting to the new API routes), a combined unauthenticated home (visitors landing on `/` are proxied to `/login`), and a nav header addition showing the signed-in email + Sign out button on all existing pages. After login/register, users land on their existing workspace (`/profile`).

**Rationale**: Matches the existing page/component style (server pages + small client forms already present in settings/upload). No new UI framework or auth widget.

**Alternatives considered**: Single combined auth page (rejected: two routes are clearer and spec says "login/register"); modal auth (rejected: more complexity, no benefit here).

## R10: Testing strategy

**Decision**: Three layers, reusing existing infra. (1) vitest unit tests for `password.ts`, `session.ts` (expiry, sliding renewal, hash-only storage), and `guard.ts`; (2) vitest integration tests against the docker Postgres asserting ownership scoping (user A cannot read/update/delete user B's roots by id; quarantined rows invisible to everyone; per-user settings isolation; cost cap per user); (3) Playwright e2e covering register → workspace, logout → login, two-browser-context isolation (A creates data, B sees nothing, direct URLs 404/redirect), and the assign-owner script claiming legacy data for the owner only. E2E reset-db script gains user seeding.

**Rationale**: The spec's success criteria are isolation- and regression-shaped (SC-003–SC-006); ownership scoping is best asserted at the data layer, while end-to-end proof needs real flows. Both runners are already configured.

**Alternatives considered**: Only e2e (rejected: slow, imprecise failure messages for scoping bugs); only unit tests (rejected: cannot prove SC-001/SC-002/SC-004 flows).
