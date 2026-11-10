# ProfileForge

A self-hostable web application that turns your existing CV into a structured,
provenance-tracked profile and generates ATS-optimized, fact-checked CVs and cover letters
from it against a pasted job description. Matching and scoring are deterministic and
reproducible, every material claim in generated documents traces back to profile evidence,
and every exported PDF is verified by automated text extraction — nothing is invented and
nothing unreadable is downloadable.

**Status** (2026-11-02, see [STATUS.md](STATUS.md)): all ten feature slices are implemented —
CV ingestion & profile ([001](specs/001-ats-cv-tailoring)), JD analysis & deterministic matching
([002](specs/002-jd-matching)), evidence-aware generation + verified export
([003](specs/003-cv-generation)), profile-editor e2e suite ([004](specs/004-profile-editing-e2e)),
selection & omissions ([005](specs/005-cv-selection-refinement)), polish & reliability
([006](specs/006-polish-reliability)), profile-editor CRUD fixes ([007](specs/007-fix-profile-editor-crud)),
multi-user isolation ([008](specs/008-multi-user-isolation)), evaluation benchmark
([009](specs/009-evaluation-benchmark)), GitHub Actions CI ([010](specs/010-github-actions-ci)).
Verification stack green: `tsc --noEmit` clean, Vitest 473/473, Playwright e2e 45 passed /
1 skipped (key-gated scenario), CI on `main` green (≈5 min, all six checks). Open items are
small: recording the live benchmark baseline (blocked on OpenRouter free-tier headroom) and a
manual GUI sanity pass.

## How it works

The user journey is a pipeline; each stage is covered by unit/integration/e2e tests.

1. **Upload & parse** (`/upload`): a French or English CV (PDF/DOCX, ≤10 MB; scanned PDFs
   rejected) is text-extracted locally, language-detected, then parsed into a draft profile by
   the LLM with your own OpenRouter key. Dates normalize deterministically (EN/FR → `YYYY-MM`,
   ambiguities flagged, never guessed); every parsed bullet is verified against the extracted
   source text (≥95% word-level containment) so invented content is flagged.
2. **Profile** (`/profile`): import into a single structured profile with bullet-level
   provenance (source document + page), full CRUD with autosave, review-flag confirmation,
   duplicate-skill merge, and version history with restore. A claims report flags dangling
   provenance and ungrounded content.
3. **Job analysis** (`/jobs`): paste an FR/EN job description; requirements are extracted
   (must/nice, hard-constraint flags), then matched deterministically:
   exact (accent-insensitive, whole-phrase) → approved aliases (built-in bilingual list +
   per-skill approvals) → LLM-proposed semantic matches that are **evidence-validated**
   (dangling citations dropped and counted). The MatchReport shows a reproducible
   60/30/10 score with breakdown, per-requirement evidence, recommended/missing keywords, and
   hard-constraint gaps that semantic resemblance never masks. Analyses are version-pinned
   and re-runnable.
4. **Generation** (async job from a matched analysis): the pipeline stages are
   `preconditions → plan → draft → fit → render → gate → persist`, with the job state
   DB-backed (`queued → running → succeeded | failed | cancelled`), cancel/retry endpoints,
   and client polling. Planning pins a profile snapshot and selects content deterministically
   (relevance + evidence strength + impact + recency) with an explicit per-section
   [SelectionRecord](specs/005-cv-selection-refinement) — every excluded entry lands in an
   inspectable, restorable omissions list. The LLM only rewrites plan items **keyed by id**, so
   every claim carries `sourceBulletIds`; the draft prompt receives the job description and
   rewords summary/bullets toward its vocabulary — rewording only, facts are never added,
   merged, or dropped. A measure-and-demote loop enforces the page budget (1–3 pages) by
   recording dropped items as omissions.
5. **Verified download**: PDFs must pass a two-level extraction gate (100% structural
   recovery + ≥95% per-block word recovery, same accent-insensitive normalization for FR/EN),
   with up to 3 render attempts — a failing render fails visibly and is never downloadable.
   Two CV templates ship: the default single-column **ATS** layout and a **designed
   two-column** layout; CVs also get a best-effort DOCX, cover letters get copyable plain
   text. Download gating is purely technical; draft fallbacks render as passive notes with
   plain-language explanations, and provider failures name their cause with a next action.

The generation API: `POST /api/generations` (`{analysisId, kind, settings?}`) → 202; poll
`GET /api/generations/[id]`; document + provenance via `.../document`; omissions restore via
`.../document/omissions/[omissionId]/restore`; gated downloads via
`.../download?format=pdf|docx|txt`. Full contract:
[specs/003-cv-generation/contracts/api.md](specs/003-cv-generation/contracts/api.md).

## Architecture

Next.js 16 App Router (React 19), everything server-side in route handlers; PostgreSQL via
Prisma (19 models); no external services besides OpenRouter.

- `src/app/` — pages (`/profile`, `/upload`, `/jobs`, `/settings`, `/login`, `/register`) and
  API routes under `src/app/api/` (`auth`, `cv`, `jobs`, `generations`, `profile`,
  `settings`, `validation`)
- `src/lib/parsing/` — PDF/DOCX text extraction + FR/EN language detection (`franc`)
- `src/lib/matching/` — the deterministic matching engine (pure functions, no LLM):
  `engine.ts` (exact → alias → validated semantic), `aliases.ts`, `score.ts` (60/30/10 +
  evidence bonus)
- `src/lib/llm/` — task registry + router: five tasks (`parseCV`, `extractRequirements`,
  `semanticProposals`, `generateTailoredCV`, `generateCoverLetter`), each with Zod-validated
  payloads and prompts in `prompts/*.md`. A pluggable transport layer serves live OpenRouter
  calls or the benchmark's record/replay transcripts; per-run usage is logged to `LlmUsageLog`
  with a DB-derived spend cap
- `src/lib/generation/` — the job pipeline: `plan.ts` (snapshot + selection), `draft.ts`
  (keyed LLM rewriting), `fit.ts` (page-budget demote loop), `render/` (PDF via `pdf-lib`,
  DOCX via `docx`), `verify.ts` (extraction gate), `grounding.ts`, `repository.ts` (atomic
  job lifecycle)
- `src/lib/auth/`, `src/lib/settings/` — Argon2id passwords, opaque session tokens
  (SHA-256 stored, HttpOnly cookie, 30-day sliding), owner-scoped guards on every query,
  AES-256-GCM-encrypted per-user OpenRouter keys
- `src/components/` — UI: shadcn-style primitives, profile editor, generation views
- `prisma/` — schema, migrations, demo seed (`prisma/seed/`); generated client in
  `src/generated/prisma/` (gitignored)
- `benchmarks/`, `tests/`, `specs/` — see below

## Key technical choices

- **Deterministic core, LLM at the edges.** Matching, scoring, and content selection are pure,
  reproducible functions; the LLM only extracts requirements, proposes semantic matches
  (which the engine evidence-validates), and rewrites keyed plan items. Same inputs → same
  MatchReport.
- **Zero invented facts, claim-level provenance.** Parsed and generated bullets carry source
  references; containment checks (≥95% word-level, accent-insensitive) run at parse time and
  again at export time.
- **Verified ATS output, not assumed.** The download gate measures the actual PDF text layer;
  standard section headings, linear layouts, normalized dates.
- **Async jobs with atomic lifecycle.** In-process execution, DB-backed status, transitions
  deduped atomically, cancellation checked at every stage boundary.
- **Multi-user by default.** Every visitor registers; workspaces (profile, files, analyses,
  generations, settings) are fully isolated per account; legacy rows stay quarantined until
  claimed (`npm run db:assign-owner -- --email you@example.com`).
- **User-supplied LLM budget.** All calls route through the user's OpenRouter key with
  configurable economy/premium models (defaults: `nvidia/nemotron-3.5-super-vl:free` /
  `anthropic/claude-sonnet-4.5`) and a per-run cost cap.
- **Evaluation harness before prompt tuning.** A versioned fixture set, committed baselines,
  pinned AI transcripts, and a keyless replay mode make the benchmark a deterministic CI
  regression gate (exit codes 0–3).

## Setup

Requires Node 20+, npm ≥ 11 (the bundled npm 10.8.2 hits a lockfile bug on incremental
installs in this repo), and Docker.

```bash
docker compose up -d        # PostgreSQL 16 on host port 5435
cp .env.example .env        # then edit values
npx prisma migrate dev      # apply schema
npm run dev                 # http://localhost:3000
```

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection (compose default: `postgresql://profileforge:profileforge@localhost:5435/profileforge`) |
| `OPENROUTER_API_KEY` | your key; alternatively save it in Settings (stored AES-256-GCM encrypted, per user) |
| `APP_SECRET` | 32+ chars; encrypts a Settings-stored key (auto-generated `.appsecret` fallback) |
| `UPLOADS_DIR` | where uploaded CVs are stored (default `./uploads`) |

Register an account in the UI to get an isolated workspace; everything up to and including
the MatchReport works without an OpenRouter key — only parsing and generation call the LLM.

### Demo accounts

Two disposable accounts with rich, fully populated profiles ship for demos and manual testing.
**Local/demo use only — never reuse these credentials anywhere real.**

| Account | Email | Password | Profile |
|---------|-------|----------|---------|
| French | `demo.fr@profileforge.local` | `DemoFr2026!` | Camille Laurent — 5 roles, 4 diplomas, 16 skills, 3 languages, 4 projects, 3 certifications |
| English | `demo.en@profileforge.local` | `DemoEn2026!` | Alex Morgan — 3 roles, 2 diplomas, 10 skills, 2 languages, 2 projects, 1 certification |

```bash
npm run seed:demo-fr   # create or refresh the French demo account + profile
npm run seed:demo-en   # create or refresh the English demo account + profile
npm run demo:reset     # drop both demo users, then re-seed both from scratch
```

All three are idempotent and never touch rows belonging to other accounts. Each seed
pre-matches the demo profile against `fixtures/demo-jd-fr.txt` / `fixtures/demo-jd-en.txt`,
so `/jobs` shows a real MatchReport without any LLM calls (requirements are hand-extracted;
matching and scoring run the real deterministic engine).

## Tests & CI

```bash
npm test              # Vitest: unit + integration (routes against a test DB)
npm run build         # production build
npm run e2e:install   # one-time: Chromium for Playwright
npm run test:e2e      # browser suite (always enter through this script — it resets the e2e DB first)
```

The Vitest suite runs against `profileforge_test` and e2e against a dedicated
`profileforge_e2e` database (compose service `e2e-db`, port 5434) — both physically isolated
from dev data. LLM calls are mocked in Vitest; e2e needs no API key and its one live
upload/parse scenario self-skips without one.

**CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml), specs/010): on every push and
PR, one job runs lint → typecheck → build → Vitest (Postgres 16 service container) →
Playwright e2e → keyless benchmark. Caches for dependencies and browsers, concurrency
cancellation for superseded runs, and a failed-run e2e HTML report upload (7-day retention).

**Benchmark** (specs/009, [benchmarks/README.md](benchmarks/README.md)):

```bash
npm run benchmark -- --keyless   # deterministic stages over the pinned fixture set (no AI key)
npm run benchmark -- --record    # live run that also pins AI transcripts for --keyless
npm run benchmark                # full live evaluation with baseline comparison
```

Measures generation quality (requirement coverage + six deterministic metrics) over the
committed fixture set in `benchmarks/fixtures/`, compares against the committed baseline, and
exits `0` pass / `1` regressed / `2` incomplete / `3` config error. Live runs target their own
`profileforge_benchmark` database and cost real money (default spend cap `$1.00`).

## Project layout & documents

- `specs/` — one spec-kit directory per slice (`spec.md`, `plan.md`, `data-model.md`,
  `contracts/`, `quickstart.md`, checked-off `tasks.md`). Slice
  [001](specs/001-ats-cv-tailoring) is the parent spec and the best architecture starting point.
- [ProfileForge-Specification.md](ProfileForge-Specification.md) — the authoritative product
  reference (vision, principles, schemas, LLM task contracts).
- [STATUS.md](STATUS.md) — current state: what is done, verified, and open.
- [docs/review-2026-11-08.md](docs/review-2026-11-08.md) — architecture/code review report.

## Notes

- `:free` OpenRouter models are rate-limited (≈20 req/min); a parse failure with
  `LLM_RATE_LIMITED` means wait a minute or switch models in Settings.
- Uploads and generated artifacts live on local disk; the app is single-instance by design
  (horizontal scaling deliberately deferred).
- Also deferred by scope decision: multiple profiles per user, account deletion / password
  reset / email verification, cover-letter DOCX, job-board integrations.
