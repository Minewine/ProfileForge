# Quickstart & Validation Guide: Slice 1

Run these scenarios end-to-end to prove the slice works. Contracts: [api.md](./contracts/api.md), [llm-router.md](./contracts/llm-router.md), [parsecv-task.md](./contracts/parsecv-task.md); data model: [data-model.md](./data-model.md).

## Prerequisites

- Node.js 20+, npm
- PostgreSQL 15+ (dev default: `docker compose up -d` with the repo's compose file exposing `localhost:5432/profileforge`)
- An OpenRouter API key (paid or free-tier; economy-model usage for one parse ≪ $0.01)

## Setup

```bash
npm install
cp .env.example .env            # then edit values below
npx prisma migrate dev          # applies the slice-1 schema
npm run dev                     # http://localhost:3000
```

`.env` values:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection string |
| `OPENROUTER_API_KEY` | primary key path (env wins over the settings UI) |
| `APP_SECRET` | 32+ chars; encrypts a key stored via Settings (auto-generated `.appsecret` fallback, gitignored) |
| `UPLOADS_DIR` | default `./uploads` (gitignored) |

## Automated checks

```bash
npm test        # vitest: unit (dates, detection, containment, masking) + integration (routes w/ test DB, router w/ mocked fetch)
```

## Manual validation scenarios

1. **English CV (PDF)** — Settings → save key (validated) → Upload `tests/fixtures/cv-en.pdf` → expect: language `en`, page count, then parse completes (<120 s) → import → Profile shows experience/education/skills with provenance badges (page numbers) and all dates as `YYYY-MM`. `LlmUsageLog` rows exist; run cost < $0.01.
2. **French CV (PDF)** — upload `cv-fr.pdf` → `detectedLanguage: "fr"` → dates like "janv. 2023 – aujourd'hui" import as `2023-01 … present`; headings/labels render; no invented content.
3. **DOCX** — upload `cv-fr.docx` (or `cv-en.docx`) → same expectations, provenance locators are paragraph indexes.
4. **Scanned PDF** — upload `scanned.pdf` → immediate `NO_TEXT_LAYER` error with guidance; no SourceDocument row persisted beyond the failed-upload record; nothing crashes.
5. **Oversized / wrong format** — 11 MB file → `FILE_TOO_LARGE`; `.txt` → `UNSUPPORTED_FORMAT`.
6. **Invalid key** — Settings → validate a bogus key → `valid: false` with actionable message; then run a parse → `LLM_KEY_INVALID`, no partial draft persisted, upload still listed and re-parseable after fixing the key.
7. **Editor autosave** — edit a bullet, change a date, add a skill (duplicate name triggers merge-or-keep), delete a project → each change persists without a save button; `GET /api/profile/versions` shows version bumps with causes; refresh restores state.
8. **Language correction** — switch profile language `fr → en` in the header → metadata updates; entries unchanged.
9. **Claim validation + referential protection** — `POST /api/validation/claims` → zero blockers on a clean profile; `DELETE /api/cv/{sourceDocumentId}` while entries reference it → `409 SOURCE_IN_USE` with `affectedEntryIds`; confirm a flagged bullet via `PATCH /api/profile/entries/experience/{id} { "provenance": "user_confirmed" }` → its review flag clears and the next claims report drops the blocker.
10. **Cost cap** — temporarily set `costCapUsd` to `0.001` in Settings → next parse fails fast with `COST_CAP_REACHED` and an actionable message; raise back to `0.50`.
11. **Long CV confirmation** — upload a >10-page fixture → upload response carries `requiresPartialParseConfirmation: true`; parse without `confirmPartial` → `422 CONFIRMATION_REQUIRED`; parse with `{ "confirmPartial": true }` → `200` with `partial: true` and `omittedPages` listed.

## Expected outcomes (definition of slice success)

- Scenarios 1–11 all pass; automated suite green.
- Every parsed profile entry carries provenance (`imported` + locator, or user-entered marker) — zero ungrounded entries (the `/api/validation/claims` invariant).
- No LLM output reaches the database without passing zod validation + containment check.
