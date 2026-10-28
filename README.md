# ProfileForge

A local-first web application that turns your existing CV into a structured, provenance-tracked
profile and later generates ATS-optimized, fact-checked CVs and cover letters from it. Every
material claim is traceable to profile evidence — nothing is ever invented.

**Status**: all eight planned feature slices are implemented and verified (2026-10-28: production
build, lint, and the full test suites green — 440 Vitest tests, 45/46 Playwright e2e with one
key-gated skip): CV ingestion & structured
profile ([001](specs/001-ats-cv-tailoring)), JD analysis & deterministic matching
([002](specs/002-jd-matching)), evidence-aware CV + cover-letter generation with prompt-driven JD
tailoring and verified PDF export ([003](specs/003-cv-generation)), profile-editor e2e suite
([004](specs/004-profile-editing-e2e)), explicit selection & omissions
([005](specs/005-cv-selection-refinement)), polish & reliability ([006](specs/006-polish-reliability)),
profile-editor CRUD fix ([007](specs/007-fix-profile-editor-crud)), multi-user isolation
([008](specs/008-multi-user-isolation)), and the evaluation benchmark
([009](specs/009-evaluation-benchmark)). Full status report: [CONSOLIDATION.md](CONSOLIDATION.md).

## What works today

- **Upload** a French or English CV (PDF/DOCX, ≤10 MB). Scanned/image-only PDFs are rejected with
  guidance; CVs over 10 pages require explicit confirmation before a partial parse.
- **Parse** with your own OpenRouter key (default model `minimax/minimax-m3.1-flash:free`,
  configurable with a searchable picker in Settings). Dates are normalized deterministically
  (EN/FR → `YYYY-MM`, ambiguities flagged — never guessed), and every parsed bullet is verified
  against the extracted source text (≥95% word-level containment) so invented content is flagged.
- **Import** into a single structured profile with bullet-level provenance (source document + page).
  Re-imports preserve your manually added entries.
- **Edit** everything with autosave: all sections, bullet editor, provenance badges, review-flag
  confirmation, duplicate-skill merge-or-keep, version history with restore.
- **Validate claims**: a report on the profile that flags dangling provenance and ungrounded content.
- **Analyze job descriptions** (`/jobs`): paste an FR/EN JD, review extracted requirements, and run the
  deterministic match — exact (accent-insensitive, whole-phrase) → approved aliases (bilingual built-in
  list + your per-skill approvals) → LLM-proposed semantic matches that are **evidence-validated**
  (dangling citations are dropped and counted). The MatchReport shows a reproducible 60/30/10 score with
  breakdown, per-requirement evidence, recommended/missing keywords, and hard-constraint gaps that
  semantic resemblance never masks. Analyses are version-pinned, copyable, and re-runnable.
- **Generate** (from a matched analysis, `/jobs/[id]` step 4): an async job turns the MatchReport into a
  tailored CV and a complementary cover letter in your chosen output language (FR/EN/DE, defaulting to the
  JD's language). Content selection is deterministic and evidence-ranked (relevance + strength + impact +
  recency) with an **explicit per-section cut** ([feature 005](specs/005-cv-selection-refinement)): the
  persisted SelectionRecord shows each included entry's rank, score, match-method credits, evidence
  citations, and recency in the UI, and every unselected entry appears in the omissions list with reason
  `selection` (distinct from `page_budget`) — the union of draft + omissions always covers the whole
  profile. The premium LLM only rewrites plan items **keyed by id** — bullets **and role titles** — so
  every material claim carries `sourceBulletIds`/evidence provenance resolved against the profile
  snapshot pinned at job start (titles fall back verbatim, never title-less). The draft prompt
  receives the full job description (capped) and rewords the summary and bullets toward its
  vocabulary, priorities, and framing — **rewording only**: facts are never added, merged, or
  dropped. The Professional Summary is
  synthesized from the job's must-have requirements plus the strongest matching evidence, bounded by the
  user-facing summary-length setting (30–120 words). Page budget (1–3 pages) is enforced by a
  measure-and-demote loop that records every dropped item as an inspectable, restorable omission.
  Download gating is purely technical ([feature 006](specs/006-polish-reliability)): PDFs must pass the
  two-level extraction gate, draft fallbacks (verbatim fallback, uncertain translation) render as a
  passive "Draft notes" block with one-sentence plain-language explanations, AI-provider failures name
  their cause (rejected key, exhausted credit, rate limit, unavailability) with a concrete next action,
  and generation shows a persistent progress indicator. Two
  render templates are selectable for CVs: the default single-column **ATS** layout and a **designed
  two-column** template (shaded sidebar with contact/skills/languages, main column with
  summary/experience/education) that renders every list dynamically — both produce text-layer PDFs that
  must pass the two-level extraction gate (100% structural recovery + ≥95% per-block word recovery)
  before download is offered; a failing render is retried, then fails visibly — never downloadable.
  Cover letters add a tone setting, a 1-page budget, and copyable plain text; CVs add a best-effort DOCX
  matching the selected template (the PDF is the verified deliverable).

### Download gate matrix

| Format | Extraction gate | Notes |
|--------|-----------------|-------|
| PDF (CV & letter) | required | the verified deliverable; failing renders are never stored |
| DOCX (CV) | not applied | best-effort convenience output (decided parent exception) |
| TXT (letter) | not applied | copyable plain text for application forms |

### Generation API

`POST /api/generations` (`{analysisId, kind: "cv" | "cover_letter", settings?}`) → 202; poll
`GET /api/generations/[id]`; cancel/retry via `POST .../cancel` / `.../retry`; document +
provenance via `GET .../document`, omission restore via
`POST .../document/omissions/[omissionId]/restore`; gated downloads via
`GET /api/generations/[id]/download?format=pdf|docx|txt`. Full contract:
[specs/003-cv-generation/contracts/api.md](specs/003-cv-generation/contracts/api.md).

## Setup

```bash
docker compose up -d        # PostgreSQL on host port 5433
cp .env.example .env        # then edit values
npx prisma migrate dev      # apply schema
npm run dev                 # http://localhost:3000
```

`.env` values:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection (docker compose default: `postgresql://profileforge:profileforge@localhost:5433/profileforge`) |
| `OPENROUTER_API_KEY` | your key; alternatively save it in the Settings UI (stored AES-256-GCM encrypted) |
| `APP_SECRET` | 32+ chars; encrypts a Settings-stored key (auto-generated `.appsecret` fallback) |
| `UPLOADS_DIR` | where uploaded CVs are stored (default `./uploads`) |

The first run of the test suite generates fixtures: `npm run fixtures`.

## Accounts & multi-user

Every visitor must register (email + password, ≥8 chars) before reaching the app; each account gets
a fully isolated workspace — profile, uploaded CVs, job analyses, generated documents, files, and
settings ([specs/008-multi-user-isolation](specs/008-multi-user-isolation)). Sessions are opaque
tokens in an HttpOnly cookie (`pf_session`, 30 days, sliding renewal); only the token's SHA-256 is
stored server-side. Passwords are Argon2id-hashed; OpenRouter keys stay AES-256-GCM encrypted, now
per user.

**Upgrading a pre-multi-user installation**: the schema change quarantines all existing rows
(owner-less rows are invisible to every account). Claim them for one designated owner after
registering that account:

```bash
npm run db:assign-owner -- --email you@example.com   # creates the account if absent, then claims all legacy data
```

The script is idempotent; re-running claims nothing new. Unclaimed data stays invisible to everyone
until claimed — it is never exposed to other accounts.

## Tests

```bash
npm test        # vitest: unit (dates, language, containment, router, keystore, generation pipeline)
                # + integration (routes w/ test DB, incl. the full generation/gate flows)
npm run build   # production build

npm run e2e:install   # one-time: Chromium for Playwright
npm run test:e2e      # browser-level profile-editor suite (specs/004-profile-editing-e2e)
```

The vitest suite runs against a `profileforge_test` database and the E2E suite against a dedicated
`profileforge_e2e` database (compose service `e2e-db` on port **5434**, `uploads-e2e/`): both are
physically isolated from your dev data, and the E2E harness aborts before mutating anything unless its
database URL targets `profileforge_e2e`. LLM calls are mocked in vitest; the E2E suite needs no API key
(fixtures seed through the app's own routes), and its optional upload scenario self-skips without one.

### CI (specs/010-github-actions-ci)

GitHub Actions (`.github/workflows/ci.yml`) runs the same checks on every push and pull request, in one
job: lint → typecheck (`npx tsc --noEmit`) → build → Vitest → Playwright e2e → keyless benchmark
(deterministic regression gate over matching/selection/render, no AI key) — any failure fails the run.
The Vitest suite runs against a Postgres 16 **service container** (same image/credentials as compose
`db`; the harness auto-creates and migrates `profileforge_test` there), while e2e keeps using its own
compose `e2e-db`. Dependencies and Playwright browsers are cached between runs, superseded runs on the
same branch are cancelled, and a failed e2e run uploads its HTML report (7-day retention) for diagnosis.

### Benchmark (specs/009-evaluation-benchmark)

```bash
npm run benchmark -- --keyless   # deterministic stages over the pinned fixture set (no AI key needed)
npm run benchmark -- --record    # live run that also pins AI transcripts for --keyless
npm run benchmark                # full live evaluation with baseline comparison
```

Measures generation quality (requirement coverage + six deterministic metrics) over the
version-controlled fixture set in `benchmarks/fixtures/`, compares against the committed baseline, and exits `0` pass / `1` regressed /
`2` incomplete / `3` config error — see [benchmarks/README.md](benchmarks/README.md) and
[specs/009-evaluation-benchmark](specs/009-evaluation-benchmark). Live runs target their own
`profileforge_benchmark` database and cost real money (default spend cap `$1.00`).

## Project layout

- `src/app/` — App Router pages (`/profile`, `/upload`, `/jobs`, `/settings`, `/login`, `/register`)
  and all API routes under `src/app/api/`
- `src/lib/` — domain logic: `parsing/` (PDF/DOCX + language detection), `matching/`,
  `generation/` (pipeline, plan, draft, fit, render, verify), `llm/` (OpenRouter router + task
  prompts), `settings/`, `validation/`, `auth/`, `profile/` & `jobs/` repositories
- `src/components/` — UI: shadcn-style primitives (`ui/`), profile editor, generation views
- `prisma/` — schema (19 models) and migrations; generated client lives in `src/generated/prisma/`
- `tests/` — `unit/` + `integration/` (Vitest), `e2e/` (Playwright, seeded through the app's own API)
- `specs/` — one spec-kit directory per feature slice (see below)

## Design documents

Each slice has a directory under `specs/` (`001-ats-cv-tailoring` … `008-multi-user-isolation`) with
`spec.md` (requirements), `plan.md` (architecture), `data-model.md`, `contracts/` where applicable,
`quickstart.md` (validation scenarios), and `tasks.md` (checked-off task list). Slice 001 is the
parent spec and the best starting point for architecture.
The authoritative product reference is [ProfileForge-Specification.md](ProfileForge-Specification.md);
[CONSOLIDATION.md](CONSOLIDATION.md) tracks what is done, what is verified, and what to build next.

## Notes

- Multi-user (specs/008): email+password accounts, per-user data isolation, per-user encrypted
  OpenRouter key. Uploads and generated artifacts remain on local disk; single instance.
- `:free` OpenRouter models are rate-limited (≈20 req/min) — a parse failure with
  `LLM_RATE_LIMITED` means wait a minute or switch models in Settings.
- Use npm ≥ 11 for package installs (`npx npm@11 install`); the bundled npm 10.8.2 hits a
  lockfile bug on incremental installs in this repo.
