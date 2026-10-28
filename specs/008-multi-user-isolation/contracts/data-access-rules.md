# Contract: Data-Access & Ownership Rules

Feature: `008-multi-user-isolation` · Date: 2026-10-26

Every existing page and API route gains the same two-layer rule (see [auth-api.md](./auth-api.md) for the new auth endpoints). Layer 1 authenticates; layer 2 scopes every lookup to the signed-in user. These rules apply to **all** HTTP methods of each route.

## Layer 1 — Authentication

- **API routes** (`src/app/api/**`): call `requireUser()` first. No valid session → `401 { error: { code: "UNAUTHENTICATED" } }`. No application data is ever returned or mutated.
- **Server pages** (`src/app/{,jobs,profile,settings,upload}/**`): call `getCurrentUser()`; if null → redirect to `/login`. Applies to `/`, `/profile`, `/upload`, `/jobs`, `/jobs/[id]`, `/settings`.
- **`/login`, `/register`**: if a valid session exists, redirect to `/profile`.
- **`src/proxy.ts`** (Next 16; middleware is deprecated): cookie-*presence* check only — no cookie + protected page path → redirect `/login` (optimistic UX; not a security boundary).

## Layer 2 — Ownership scoping (401 vs. NOT_FOUND)

Root lookups always include `userId`; a miss behaves exactly like a missing resource — `NOT_FOUND` (existing error code), never a response that confirms another user's data exists (spec FR-006). Cross-root access is denied identically.

| Route(s) | Root resolved through | Ownership rule |
|---|---|---|
| `/api/profile`, `/api/profile/import`, `/api/profile/versions*`, `/api/profile/entries/**` | `Profile` | The user's own profile row is resolved **by `userId`** (replaces the global `findFirst()` at `src/lib/profile/repository.ts:59`). A user with no profile gets the same create-on-demand behavior as today. Entry/version mutations resolve the row through the owning profile, else `NOT_FOUND`. |
| `/api/cv/upload` | — (creates) | Created `SourceDocument` is stamped with the current user's id. |
| `/api/cv/[id]`, `/api/cv/[id]/parse` | `SourceDocument` | `findFirst({ id, userId })` — else `NOT_FOUND`. Uploaded files on disk are only ever served through these ownership-checked routes; `storagePath` is never exposed. |
| `/api/jobs`, `/api/jobs/[id]`, `/api/jobs/[id]/{extract,confirm,match,requirements,rerun}` | `JobAnalysis` | List: `where { userId }`. By id: `findFirst({ id, userId })` — else `NOT_FOUND`. Created analyses are stamped with the current user. |
| `/api/generations`, `/api/generations/[id]`, `/api/generations/[id]/{cancel,retry,download,document}`, `/api/generations/[id]/document/**` | `GenerationJob` → its `JobAnalysis` | Every lookup joins through the analysis: `analysis.userId` must equal the current user — else `NOT_FOUND`. Downloads (PDF/DOCX artifacts) are served only after this check. |
| `/api/settings`, `/api/settings/models`, `/api/settings/validate-key` | `AppSettings` (per-user) | Read/write **the signed-in user's** settings row only. `validate-key` validates the caller's own key. The decrypted key exists only in server memory during a call; plaintext never appears in responses (hint only, as today). |
| `/api/validation/claims` | context entity → root | Whatever document/version the request names must resolve through an analysis owned by the current user — else `NOT_FOUND`. |

## Library-layer invariants (enforced by tests)

1. **No global reads remain**: `db.profile.findFirst()` without a `userId` predicate and `db.appSettings.findUnique({ id: "singleton" })` are removed from production code paths.
2. **Single guard, one job per layer**: `requireUser()` / `getCurrentUser()` are the only session readers; domain libs receive `userId` as a parameter and never read cookies themselves.
3. **Cost cap per user**: LLM calls resolve the current user's key, model prefs, and cap; usage rows are written with the user's id; cap checks aggregate by that id (FR-008).
4. **Quarantine**: rows with `userId IS NULL` (pre-migration legacy data) match no user's queries — visible to nobody until `scripts/assign-owner.ts` claims them (FR-009).
