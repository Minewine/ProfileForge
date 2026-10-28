# Implementation Plan: Multi-User Support with Per-User Isolation

**Branch**: `008-multi-user-isolation` | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-multi-user-isolation/spec.md`

## Summary

Add account-based access to ProfileForge: visitors register and sign in with email + password; every signed-in user gets a fully isolated workspace (profile, uploaded CVs, job analyses/match reports, generation jobs, generated documents, files); the OpenRouter key, model preferences, and cost cap move from a global singleton to per-user encrypted settings. The existing single-user data is quarantined by the schema change (owner-less rows are invisible to everyone) and claimed for a designated owner by a one-time script. All existing features keep working unchanged for a signed-in user; unauthenticated visitors see only login/register.

Technical approach: minimal custom auth (Argon2id password hashing + opaque DB-backed session tokens in an HTTP-only cookie) following the official Next.js 16 authentication guide; ownership enforced at the three root entities (Profile, SourceDocument, JobAnalysis) plus per-user settings, with children reached only through those roots; a `requireUser()`/`getCurrentUser()` guard module used by every route handler and server page; `src/proxy.ts` (Next 16 replacement for middleware) performs the optimistic unauthenticated redirect only.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js (Next.js 16.4.2, React 19, App Router)

**Primary Dependencies**: Next.js 16.4.2, Prisma 7.10.1 (`prisma-client` generator, `@prisma/adapter-pg`), zod. New: `@node-rs/argon2` (Argon2id hashing).

**Storage**: PostgreSQL 16 via docker compose (`db:up`); uploaded CVs and generated artifacts remain on the local filesystem (access control changes only).

**Testing**: vitest (unit/integration), Playwright (GUI e2e, already configured with `test:e2e` + reset-db script).

**Target Platform**: self-hosted local/small-team web app on Linux; single instance.

**Performance Goals**: unchanged from current app; authentication adds one indexed session lookup per request (<10 ms).

**Constraints**: MVP simplicity — no teams, sharing, roles, or email verification; all existing features must behave identically for a signed-in user; API keys never retrievable in plaintext; passwords/keys never logged.

**Scale/Scope**: handful of users per deployment; 6 existing pages + 28 existing API routes gain an auth guard and ownership scoping; 3 new auth endpoints; 2 new pages.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project's `.specify/memory/constitution.md` is an unfilled template — no principles are ratified, so there are no gates to evaluate. Pre-design check: PASS (vacuous). Post-Phase-1 re-check: PASS (vacuous). The spec-level constraint that functions as a constitution in practice — "keep the implementation as simple as possible for an MVP" — is honored by choosing custom minimal auth over a framework, scoping ownership at 3 root entities instead of every table, and reusing the existing crypto/error/guard conventions.

## Project Structure

### Documentation (this feature)

```text
specs/008-multi-user-isolation/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── auth-api.md      # New auth endpoints
│   └── data-access-rules.md  # Ownership scoping rules for every existing route/page
└── tasks.md             # Phase 2 output ($speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── proxy.ts                          # NEW — Next 16 proxy: optimistic redirect to /login
├── app/
│   ├── login/page.tsx                # NEW — sign-in form (link to register)
│   ├── register/page.tsx             # NEW — registration form
│   └── api/auth/
│       ├── register/route.ts         # NEW
│       ├── login/route.ts            # NEW
│       ├── logout/route.ts           # NEW
│       └── session/route.ts          # NEW — GET current user for the client
├── lib/
│   ├── auth/
│   │   ├── password.ts               # NEW — Argon2id hash/verify
│   │   ├── session.ts                # NEW — create/read/destroy DB sessions, cookie helpers
│   │   └── guard.ts                  # NEW — requireUser() (API) / getCurrentUser() (RSC)
│   ├── api/errors.ts                 # EXTEND — auth error codes (EMAIL_TAKEN, INVALID_CREDENTIALS, UNAUTHENTICATED)
│   ├── settings/keyStore.ts          # EXTEND — per-user key row instead of "singleton"
│   ├── settings/store.ts             # EXTEND — per-user settings
│   ├── profile/repository.ts         # EXTEND — every entry point takes/derives userId
│   ├── jobs/  generation/  files/    # EXTEND — root fetches scoped by userId
│   └── db.ts                         # unchanged
└── components/                       # EXTEND — nav gains user email + sign-out

prisma/
├── schema.prisma                     # EXTEND — User, Session; userId on roots; AppSettings per user
└── migrations/<n>_multi_user/        # NEW — migration (nullable owner columns)

scripts/
└── assign-owner.ts                   # NEW — one-time: create/lookup owner by email, claim quarantined rows

tests/
├── unit/ (vitest)                    # EXTEND — password, session, guard, ownership scoping
└── e2e/ (playwright)                 # EXTEND — register/login/logout, two-user isolation, migrated-data access
```

**Structure Decision**: extend the existing single Next.js app in place — no new services or packages. Auth lives in a new `src/lib/auth/` module plus 4 route handlers and 2 pages; ownership scoping is added inside the existing repository/lib modules rather than a new abstraction layer, matching the current codebase style (direct Prisma calls, helper libs per domain).

## Complexity Tracking

> No constitution violations to justify — the section stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
