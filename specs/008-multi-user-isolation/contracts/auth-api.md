# Contract: Auth API

Feature: `008-multi-user-isolation` · Date: 2026-10-26

New JSON endpoints under `/api/auth`, following the existing route-handler + zod + error-code conventions (`src/lib/api/errors.ts`). Error responses use the established `{ error: { code, message } }` shape of the existing API.

## New error codes (added to `ERROR_CODES`)

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session (data APIs return this instead of data) |
| `INVALID_CREDENTIALS` | 401 | Login failed — same code for unknown email and wrong password (no enumeration) |
| `EMAIL_TAKEN` | 409 | Registration with an already-registered email (after normalization) |
| `VALIDATION_ERROR` | 400 | (exists) malformed email/password fields |

## Endpoints

### `POST /api/auth/register`

Request: `{ "email": string, "password": string }`

- Normalizes email (trim + lowercase); validates shape and password ≥ 8 chars → `VALIDATION_ERROR`.
- Creates the User (Argon2id hash), creates a Session, sets the `pf_session` cookie.
- `201` → `{ "user": { "id": string, "email": string } }` + `Set-Cookie: pf_session=…`
- `409 EMAIL_TAKEN` if the normalized email already exists (checked atomically; race-safe via the DB unique index).

### `POST /api/auth/login`

Request: `{ "email": string, "password": string }`

- Normalizes email; verifies Argon2id hash. Unknown email and wrong password return the identical `401 INVALID_CREDENTIALS` response.
- On success creates a Session, sets the cookie. `200` → `{ "user": { "id": string, "email": string } }`.

### `POST /api/auth/logout`

Requires a session (cookie). Deletes the Session row and clears the cookie. `204` (no body). Idempotent: no/invalid cookie still yields `204`.

### `GET /api/auth/session`

Returns the current user for client bootstrapping.

- `200` → `{ "user": { "id": string, "email": string } }`
- `401 UNAUTHENTICATED` when signed out.

## Cookie contract

| Attribute | Value |
|---|---|
| Name | `pf_session` |
| Value | opaque 32-byte base64url token (server stores only its SHA-256) |
| HttpOnly | yes |
| SameSite | Lax |
| Secure | yes when the request is HTTPS |
| Path | `/` |
| Max-Age | 30 days (sliding renewal by server, which re-sets the cookie when it extends the session) |

## Non-goals

No password reset, email verification, "remember me" toggle, or refresh-token machinery (spec Assumptions). No CSRF token: all mutating auth endpoints are JSON-only with `SameSite=Lax` cookies, matching the existing API's JSON-only design; revisit if the app ever adds cross-site embeds.
