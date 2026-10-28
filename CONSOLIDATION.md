# CONSOLIDATION — ProfileForge project state

**Date:** 2026-10-28 · **Scope of this pass:** documentation only — no application code was changed.
**All four verification layers were re-run live during this consolidation and are green:** production
build ✅ · Vitest 420/420 ✅ · Playwright e2e 45 passed / 1 key-gated skip ✅ · ESLint 0 errors ✅
(full log in the Appendix).

## TL;DR

All eight spec'd feature slices are **implemented**, with 276/276 tasks checked off and a green
verification stack as of today. The one serious risk is process, not code: **the entire application
is uncommitted** — git history contains only the Create Next App scaffold commit, and no remote is
configured. Commit first (§5), then add CI, then build the one missing core module (the Evaluation
benchmark).

## 1. Feature slice inventory

Status legend: **Spec only** (described in the master spec, no `specs/NNN` directory) · **Planned** ·
**Tasks exist** · **Implemented** (tasks complete + code + automated tests).

| Slice | Title | Status | tasks.md | Code evidence |
|---|---|---|---|---|
| 001-ats-cv-tailoring | ATS-Optimized CV & Cover Letter Tailoring (MVP, FR/EN) | Implemented | 41/41 | `src/app/api/cv/*`, `src/lib/parsing/`, `src/lib/validation/sourceContainment.ts`, `/upload` page |
| 002-jd-matching | JD Analysis & Deterministic Matching | Implemented | 29/29 | `src/app/api/jobs/*`, `src/lib/matching/` (exact → alias → evidence-validated semantic), MatchReport stored on `JobAnalysis` |
| 003-cv-generation | Evidence-Aware CV & Letter Generation (JD-tailored prompts + ATS Export) | Implemented | 54/54 | `src/lib/generation/pipeline.ts` (6-stage async: preconditions, plan, draft, render, gate, persist), `plan.ts` (JD text into the draft prompts), `render/`, `verify.ts` extraction gate, `/api/generations/*`. Fact Guard removed 2026-10-28 — warnings-only report, no claim resolution |
| 004-profile-editing-e2e | Profile Editing End-to-End Test Suite | Implemented | 19/19 | `tests/e2e/` — 13 specs / 46 tests against an isolated `profileforge_e2e` database |
| 005-cv-selection-refinement | Explicit, Evidence-Backed Selection & Rewriting | Implemented | 32/32 | `SelectionRecord` (`generation/schemas.ts`), selection cut in `plan.ts`, omissions list + restore route |
| 006-polish-reliability | Polish & Reliability Slice | Implemented | 17/17 | `client-messages.ts`, generation progress + disabled-with-reason controls (Fact Guard UX removed 2026-10-28 with the guard itself; downloads gate only on the extraction check) |
| 007-fix-profile-editor-crud | Fix Profile Editor CRUD | Implemented | 41/41 | `profile-view.tsx` debounced autosave, `profile/entries/*` routes, `MergeOrKeepDialog` |
| 008-multi-user-isolation | Multi-User Support with Per-User Isolation | Implemented | 43/43 | auth routes + `src/lib/auth/` (Argon2id, hashed session tokens), `userId` scoping in every repository, per-user settings/keys, e2e specs 11–13 |
| 009-evaluation-benchmark | Evaluation Benchmark (master-spec Evaluation module) | Implemented *(2026-10-28 addendum)* | 38/38 | `src/lib/benchmark/*`, `scripts/run-benchmark.ts`, `benchmarks/` (fixtures, baselines, transcripts); see [specs/009-evaluation-benchmark](specs/009-evaluation-benchmark) |
| — (master spec §3) | ~~**Evaluation benchmark** (`runBenchmark`)~~ | **→ shipped as 009** | — | see row above |
| — (master spec §3) | **Evaluation benchmark** (`runBenchmark`) | **Spec only** | none | no `specs/009-*`, no benchmark code or tests |

No slice sits in "Planned" or "Tasks exist" state: every feature with a `specs/` directory is fully
implemented. All eight spec headers nevertheless still read "Status: Draft" (documentation debt —
see §3.8). `.specify/feature.json` still names 008 as the current feature.

Deferred by design (deliberate scope decisions, not gaps): multiple profiles per user; account
deletion / password reset / email verification; CI (declared out of scope in 004); cover-letter
DOCX; job-board integrations; horizontal scaling (local-first single instance); concurrent
multi-tab editing.

## 2. What currently works end-to-end

The full user journey is functional and covered by automation: **register → log in → upload a FR/EN
CV (PDF/DOCX ≤ 10 MB; scanned/image-only files rejected) → parse with your own OpenRouter key →
review the parsed draft → import into the profile with bullet-level provenance → edit everything
(debounced autosave, version history with restore, duplicate-skill merge-or-keep) → paste a job
description → extract requirements → run the deterministic match (60/30/10 score, exact → approved
alias → evidence-validated semantic) → launch async generation → review the selection record,
omissions, and provenance → download** (extraction-verified PDF; best-effort template-matched CV
DOCX; copyable plain-text letter). The draft LLM receives the full job description and rewords the
content toward it under the zero-invention rules (Fact Guard claim resolution was removed
2026-10-28). Multi-user isolation works throughout, including claiming
quarantined pre-multi-user data via `npm run db:assign-owner`.

Evidence:

| Check | Command | Result | When |
|---|---|---|---|
| Production build (24 API routes + 8 pages) | `npm run build` | pass | 2026-10-28 |
| Unit + integration suite | `npm test` | 420/420 pass (35 files, 44 s) | 2026-10-28 |
| Browser e2e suite | `npm run test:e2e` | 45 passed, 1 skipped (key-gated upload scenario), 1.2 min | 2026-10-28 |
| Lint | `npm run lint` | 0 errors, 7 warnings (test files only) | 2026-10-28 |
| Manual GUI walkthrough of the live-LLM flow | — | screenshots in `gui-test-screenshots/` | 2026-10-26 |

Caveat: the **live-LLM paths** (CV parse, JD requirement extraction, real generation with real
models) are mocked in Vitest, and the e2e upload scenario self-skips without an `OPENROUTER_API_KEY`.
They were last exercised manually in the 2026-10-26 GUI session, not by automation.

## 3. Known gaps and risk areas

Nothing is currently known broken. Ordered by importance:

1. **The entire implementation is uncommitted.** `git log` holds only the initial scaffold commit;
   `git remote -v` is empty. One careless `git clean`, disk failure, or bad checkout erases the
   whole project. This is the single largest risk.
2. **No CI.** `.github/` does not exist. The 276-task investment is protected only by local runs.
   The harness is CI-ready by design (isolated `profileforge_test`/`profileforge_e2e` databases,
   reset script that aborts on non-e2e URLs, prod-build Playwright webServer, API-seeded fixtures),
   and spec 004 explicitly deferred CI as future work.
3. **Two local-artifact directories are not gitignored:** `gui-test-screenshots/` and
   `uploads-e2e/`. A naive `git add -A` would commit them (test reports and `.next` already are
   ignored correctly).
4. **The LLM spend cap is in-memory** (`src/lib/llm/usage.ts` keeps per-run accumulation in a
   module-level Map). A server restart resets accumulated spend, so the per-user `costCapUsd` can
   be silently re-armed mid-month. `LlmUsageLog` rows already exist — the accumulation just isn't
   derived from them.
5. **Isolation is enforced in code, not by the schema.** `userId` is nullable on the six user-rooted
   models (a deliberate legacy-quarantine pattern served by `scripts/assign-owner.ts`), and child
   rows rely on every query chaining the ownership check through the parent. A future query path
   that forgets the filter would silently widen access. The integration suite (`ownership-scoping`,
   8 cases) is the current safety net.
6. **Live-LLM paths are unautomated** (see caveat above). Optional follow-up: a key-seeded nightly
   job that runs the upload→generate journey against a cheap model.
7. **Account management is minimal:** no password reset, no email verification, no account
   deletion — all deliberate MVP exclusions, but password reset becomes urgent the moment a second
   real user exists.
8. **Documentation drift (partially fixed by this consolidation):** all eight spec headers still
   say "Status: Draft"; `specs/004 .../tasks.md` has 8 malformed task labels (`- [x] T00- [ ] T001`
   from a botched find-replace); the master spec's MVP text still says multi-user is deferred
   (now annotated in its Current Status section).
9. Minor: 7 ESLint warnings in test files; no Vitest coverage config; single-instance assumptions
   (local-disk uploads, in-memory dedupe/cost maps) that would block horizontal scaling later.

## 4. Prioritized recommendations

| # | Recommendation | Why |
|---|---|---|
| R1 | **Commit the working tree** (after gitignoring the two artifact dirs). Optionally create a remote and push. | Everything green today is the ideal checkpoint; right now the whole project lives only in an unversioned working tree (gap 1). Cheapest, highest-value action available. |
| R2 | **Add GitHub Actions CI**: lint + build + Vitest (with a `postgres:16` service) + Playwright e2e (with the `e2e-db` service), triggered on push/PR. | The e2e harness was explicitly built to run headlessly and guards itself against wrong-database mutations (gap 2). Locks in the regression safety before any new slice changes code. |
| R3 | **Spec and build the Evaluation benchmark as `specs/009-evaluation-benchmark`**: fixed profile + JD fixtures, golden extraction/match/generation outputs, a regression score report. | It is the only core module from the master specification with no slice (spec-only today). It becomes the measurable safety net for prompt edits and OpenRouter model swaps — the changes most likely to regress quality silently — and directly supports the zero-invention guarantee. |
| R4 | **Persist LLM spend accumulation** (derive per-run/per-day cost from `LlmUsageLog` instead of the in-memory Map). | Real-money control currently resets on restart (gap 4). Small, contained change to `usage.ts` + cap check. |
| R5 | **Docs hygiene sweep (~30 min):** flip the eight spec headers from "Draft" to "Implemented", fix the 8 malformed labels in 004's tasks.md, clear `.specify/feature.json`. | Prevents the next contributor (or agent) from misreading project state — the exact problem this consolidation fixes for the top-level docs. |
| R6 | **Later: account management** (password reset first), then schema-level hardening (`NOT NULL userId` once legacy data is claimed, or Postgres RLS) when moving beyond local-first. | Blockers for any hosted/multi-real-user deployment; unnecessary for the local-first tool today (gaps 5, 7). |

## 5. Exact next commands

```bash
printf 'gui-test-screenshots/\nuploads-e2e/\n' >> .gitignore   # keep local artifacts out of history
git add -A && git commit -m "feat: implement slices 001-008 — CV ingestion, matching, generation, multi-user isolation"
```

Why this and why now: it is the first real commit of the project, every verification layer passed
today (see §2), and the whole codebase currently exists only as uncommitted working-tree state —
the highest-risk finding of this consolidation. The `printf` line prevents committing local GUI
screenshots and e2e upload artifacts. One checkpoint commit is deliberate; finer-grained history
can start with the next slice (R2's CI commit is a natural second one). If you want the work off
this machine, follow with `gh repo create <name> --private --source . --push` — no remote exists yet.

## Appendix: verification log (2026-10-28)

| Command | Outcome |
|---|---|
| `npm run build` | exit 0 — 24 API routes, 8 pages, proxy; no type errors |
| `npm test` | exit 0 — 35 test files, 420/420 passed in 43.9 s (against `profileforge_test`) |
| `npm run test:e2e` | exit 0 — 13 specs: 45 passed, 1 skipped (`07-upload-optional`, self-skips without `OPENROUTER_API_KEY`), 1.2 min (against `profileforge_e2e`) |
| `npm run lint` | exit 0 — 0 errors, 7 warnings (all in `tests/`) |
| `docker compose ps` | `db` (5433) and `e2e-db` (5434) both up and healthy |

Previous recorded runs: Playwright e2e passed 2026-10-27 17:11 (`test-results/.last-run.json`);
manual GUI session 2026-10-26 (`gui-test-screenshots/`, 14 screenshots covering home, profile,
job detail, generation draft, claim confirmation, and settings).
