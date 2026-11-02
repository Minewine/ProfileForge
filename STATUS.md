# STATUS — ProfileForge project state

**2026-11-02.** This file supersedes `CONSOLIDATION.md` and `STATUS-009-IMPLEMENTATION.md`
(both removed; recoverable from git history if needed).

## TL;DR

All ten feature slices are implemented and committed/pushed to
`github.com/Minewine/ProfileForge` (`main`). The verification stack is green locally as of
today (see §3). CI exists (spec 010) and was broken by a missing Prisma-client generation
step — fixed on 2026-11-02; the remaining 010 work is validating the runs, not writing code.
The two long-pole open items both need an OpenRouter account with headroom, not code.

## 1. Feature slices

| Slice | Title | tasks.md | Notes |
|---|---|---|---|
| 001-ats-cv-tailoring | ATS CV & cover-letter tailoring (FR/EN) | 41/41 | |
| 002-jd-matching | JD analysis & deterministic matching | 29/29 | |
| 003-cv-generation | Evidence-aware generation + ATS export | 54/54 | |
| 004-profile-editing-e2e | Profile editing e2e suite | 19/19 | |
| 005-cv-selection-refinement | Selection & rewriting views | 32/32 | |
| 006-polish-reliability | Polish & reliability | 17/17 | |
| 007-fix-profile-editor-crud | Profile editor CRUD fixes | 41/41 | |
| 008-multi-user-isolation | Multi-user isolation | 43/43 | |
| 009-evaluation-benchmark | Evaluation benchmark | 37/38 | T037 open: live baseline (§4) |
| 010-github-actions-ci | GitHub Actions CI | 14/18 | T012/T015/T016/T018 open: run validation (§4) |

Deliberately deferred (scope decisions, not gaps): multiple profiles per user; account
deletion / password reset / email verification; cover-letter DOCX; job-board integrations;
horizontal scaling.

## 2. Recent changes (2026-11-02 pass)

- **CI fixed.** Runs were failing at typecheck because `src/generated/` (Prisma client) is
  gitignored and CI never generated it. `npm ci` now triggers `prisma generate` via a
  package.json `postinstall` hook. The benchmark model mapping moved from an inline literal
  to the workflow env var `BENCHMARK_FREE_MODELS` (with re-record instructions in the
  comment) — when a free model is retired upstream, that is now a one-line change made
  together with the re-recorded transcripts.
- **Run cost cap is DB-derived.** `src/lib/llm/usage.ts` sums the run's `LlmUsageLog` rows
  instead of a module-level Map, so a server restart no longer resets accumulated spend.
  (Cap semantics are per-run, unchanged.)
- **Upload workspace survives reload.** Extraction state and the parse draft were already
  persisted on the `SourceDocument` row; the client now stores a `localStorage` pointer to
  the last uploaded document and `GET /api/cv/[id]` restores the workspace on mount
  (`src/app/upload/upload-view.tsx`). A hard reload no longer loses the draft.
- **Dev DB moved off host port 5433 → 5435.** Another local project (copypocket) binds
  5433; the collision made ProfileForge's tests silently authenticate against the wrong
  Postgres. `e2e-db` stays on 5434 (uncontested). Only `docker-compose.yml`, `.env` /
  `.env.example`, `reset-db.mjs`, `README.md`, and the 003 quickstart reference the port —
  historical spec docs (plan/research/data-model) still mention 5433 as written at the time.
- **Docs hygiene.** Spec headers flipped from "Draft" to "Implemented" (with pending-task
  annotations for 009/010); the 8 malformed task labels in 004's tasks.md fixed;
  `.specify/feature.json` cleared; duplicate `.gitignore` entry removed; the three
  overlapping root status docs consolidated into this file.

## 3. Verification (2026-11-02, local)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 18 warnings (test files only) |
| `npm test` (Vitest) | 45 files, 473/473 passed |
| `npm run test:e2e` | 45 passed, 1 skipped (key-gated upload scenario), ~2.7 min |
| CI on `main` | green — run 41483641365 (292 s); 010 fully validated incl. failure paths |
| `npx prisma generate` | client regenerated, 252 ms |

Note: one e2e invocation showed spurious failures in `02-experience-crud` (PATCH
wait timeout) and `13-legacy-data-claim` (stateful spec run against an un-reset DB); both
pass cleanly after `reset-db.mjs`. If `13-legacy-data-claim` fails, you skipped the reset —
always enter e2e through `npm run test:e2e`.

## 4. Open items (ordered)

1. ~~Validate CI runs (010)~~ **Done 2026-11-02** — T012 first green run (292 s), T015
   cache hits (npm 67 s → 15 s, Playwright 18 s → 9 s), T016 concurrency cancellation,
   T018 full failure-path matrix + PR trigger. See specs/010 tasks.md for run IDs.
2. **Live benchmark baseline (009 T037).** Blocked on OpenRouter free-tier daily cap / zero
   credits on the account. Resume with the `--record` command in git history
   (STATUS-009-IMPLEMENTATION.md) once the cap resets or credits exist. Until then the
   keyless replay in CI is the regression gate.
3. **Manual GUI walkthrough T4–T6** from the 2026-10-28 session (profile edit persistence,
   job matching, generation + download against the live app). Automated coverage exists;
   this is the live-LLM sanity pass.
4. **Account management** when a second real user appears: password reset first, then
   account deletion; later schema-level isolation hardening (NOT NULL userId once legacy
   rows are claimed).
5. Minor: 18 lint warnings in test files; no Vitest coverage config; single-instance
   assumptions (local-disk uploads) that would block horizontal scaling.

## 5. Environment watch

- **Economy model:** `nvidia/nemotron-3.5-super-vl:free` (set 2026-10-28 after
  `minimax/minimax-m3.1-flash:free` was retired upstream). When it retires: swap the model
  in Settings, re-record benchmark transcripts, and update `BENCHMARK_FREE_MODELS` in
  `.github/workflows/ci.yml` in the same change — the keyless replay hash includes the
  model id, so CI and transcripts must move together.
- **Ports:** db 5435, e2e-db 5434 (both compose). CI uses its own 5432 service container.

