# Phase 1 Data Model: Multi-User Support with Per-User Isolation

Feature: `008-multi-user-isolation` · Date: 2026-10-26
Spec: [spec.md](./spec.md) · Research: [research.md](./research.md)

## New entities

### User

A person's identity. Owns exactly one private workspace.

| Field | Type | Rules |
|---|---|---|
| id | String (cuid) | PK |
| email | String | **unique**; stored normalized: trim + lowercase (FR-012) |
| passwordHash | String | Argon2id (`@node-rs/argon2`); never returned by any API, never logged (FR-013) |
| createdAt / updatedAt | DateTime | timestamps |

Registration validation (zod, matching existing API style): email must be a valid address after normalization; password minimum 8 characters. Login performs the same normalization before lookup.

### Session

One row per signed-in browser session. Server-side revocable.

| Field | Type | Rules |
|---|---|---|
| id | String (cuid) | PK |
| tokenHash | String | **unique**; SHA-256 hex of the cookie token (raw token never stored) |
| userId | String | FK → User, onDelete: Cascade; indexed |
| expiresAt | DateTime | created = now + 30 days; sliding renewal extends when <15 days remain |
| createdAt | DateTime | timestamp |

State transitions: created on register/login → active (validated on every request: `tokenHash` match AND `expiresAt > now`) → ended (deleted on logout) or expired (filtered out; rows deletable lazily or by the reset-db script). Cookie: `pf_session`, HttpOnly, SameSite=Lax, Secure when HTTPS, Path=/, Max-Age 30 days.

## Changed entities

### AppSettings → per-user settings (was global singleton)

| Field | Change |
|---|---|
| id | Kept as PK (`@default(cuid())`, the `"singleton"` default removed). `userId` becomes **`String? @unique`** (FK → User, onDelete: Cascade) rather than the PK: a NOT NULL PK cannot hold the quarantined legacy singleton row, so nullable-unique preserves quarantine until the claim script attaches it. |
| openRouterKeyEncrypted | unchanged semantics: AES-256-GCM `v1.<iv>.<tag>.<ct>` from `src/lib/settings/crypto.ts` (FR-007 — same encryption, now one row per user) |
| keyHint, modelEconomy, modelPremium, costCapUsd | unchanged; now scoped per user (FR-008) |

Existing call sites (`keyStore.ts`, `store.ts`) read/write via `findUnique({ where: { userId } })`. The legacy singleton row is migrated by the assign-owner script together with the rest of the legacy data (or deleted if the owner already configured their own settings).

### Ownership columns added (nullable during migration; `NULL` = quarantined, invisible to everyone)

| Table | New column | Why at root only |
|---|---|---|
| Profile | userId (FK → User, indexed) | All profile sections, bullets, and snapshots are fetched via profileId (`repository.ts`) |
| SourceDocument | userId (FK → User, indexed) | Uploaded CVs + extracted content; children reference it via sourceDocumentId |
| JobAnalysis | userId (FK → User, indexed) | Requirements, GenerationJobs, GeneratedDocuments + versions all hang off analysisId |
| LlmUsageLog | userId (nullable, indexed) | Usage attribution + per-user cost-cap enforcement (FR-008) |

No `userId` on children (Experience, Education, Skill, LanguageSkill, Project, Certification, Bullet, ProfileSnapshot, JobRequirement, GenerationJob, GeneratedDocument, GeneratedDocumentVersion) — see research R5.

### Cascade relationships (new)

- User → Sessions, AppSettings, Profiles, SourceDocuments, JobAnalyses, LlmUsageLogs (all onDelete: Cascade).
- Note: Profile/SourceDocument/JobAnalysis children already cascade from their roots, so deleting a user removes their entire workspace.

## Migration plan (Prisma migrate)

1. **Migration `<n>_multi_user`**: create `User` + `Session`; add nullable `userId` columns + FKs + indexes (Profile, SourceDocument, JobAnalysis, LlmUsageLog); convert `AppSettings` PK to `userId` (existing singleton row: `userId` stays NULL → quarantined like everything else until claimed).
2. **Runtime scoping**: all queries filter by the current user's id; `NULL` rows can never match (quarantine semantics, spec US4-3 / FR-009).
3. **One-time claim script** `scripts/assign-owner.ts --email <owner>`: create-or-lookup the User by normalized email (create ⇒ prompt for password), then in one transaction set `userId` on every owner-less Profile, SourceDocument, JobAnalysis, LlmUsageLog, and the legacy AppSettings row. Idempotent (re-run claims nothing new). Optional later migration (not in this feature): tighten columns to NOT NULL once claimed.

## Validation rules summary

- Email: normalize (trim, lowercase) before every store/compare; uniqueness enforced by DB unique index (FR-012).
- Password: ≥8 chars at registration; Argon2id verify at login; constant-shape generic failure for unknown email vs. wrong password (no enumeration); never logged (FR-013).
- Session token: 32 bytes from CSPRNG; only SHA-256 hash persisted; expiry checked on every use.
- Ownership: root lookups always include `userId` — miss ⇒ `NOT_FOUND` (existing error code), never a 403 that confirms existence (FR-006).
- API key: decrypt only server-side, only for the owning user; never returned in plaintext; hint stays non-secret (FR-007).
