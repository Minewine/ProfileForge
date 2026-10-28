# Contract — E2E Suite Surface

The suite's "interfaces" are the commands, config, and fixture contracts other developers (and CI, later) rely on.

## Commands

| Script | Does |
|---|---|
| `npm run e2e:install` | One-time: `npx playwright install chromium` (+ deps note) |
| `npm run test:e2e` | `docker compose up -d e2e-db` → `node tests/e2e/scripts/reset-db.mjs` (abort-guard + schema reset + migrate) → `playwright test` (webServer builds+starts the app on :3100 with e2e env; `globalSetup` runs `seed.mjs`) |

Exit codes: non-zero on any scenario failure, on the abort guard, or on seed failure (FR-012). The main vitest suite (`npm test`) is untouched.

## `playwright.config.ts` contract

- `testDir: tests/e2e`, single `chromium` project, `fullyParallel: false`, `workers: 1` (scenarios share seeded state; file order matters).
- `webServer`: command `next build && next start`, `port: 3100`, `reuseExistingServer: !CI`, env: `DATABASE_URL` (e2e, 5434), `UPLOADS_DIR=./uploads-e2e`.
- `globalSetup`: `tests/e2e/scripts/seed.mjs` (waits for the webServer, seeds via HTTP, writes `seed-state.json`, prints main-DB counters before the run for SC-004).
- Failure output: Playwright's default error context (scenario title + assertion + screenshot/trace on retry-off runs kept minimal) satisfies FR-012's actionability rule.

## Fixture & seeding contract

- `tests/e2e/fixtures/profile.ts` exports the typed `ProfileFixture` set (EN primary + FR entry + duplicate-skill seed + inconsistent-fixture descriptor) per `data-model.md`.
- `seed.mjs` POSTs fixtures to `/api/profile/entries/[section]` + `PATCH /api/profile` against the app under test; asserts `201`/`200` and the returned `version` increments; writes `tests/e2e/.seed-state.json` (gitignored) with `{profileVersionAfterSeed, entryIds, inconsistent, duplicateSkillName}`.
- The inconsistent fixture is applied by `seed.mjs` **last**, via one `pg` `UPDATE` setting `review_flag = 'containment_failed'` on a seeded `user_entered` experience bullet — the suite's only direct-DB write.
- Scenario isolation: specs run in the fixed order (seed-and-display → experience-crud → sections-crud → autosave → version-history → provenance-claims); each spec's `test.describe` states the state it expects (clean seed vs post-CRUD), and mutations inside a scenario are scoped to entries that scenario created wherever the assertion allows.

## Selector contract (support/editor.ts page objects)

- Sections are located by their CardTitle text (`Experience`, `Education`, `Skills`, `Languages`, `Projects`, `Certifications`); a section's add button is `+ Add` within the section card; entries carry `data-testid="entry-{section}-{id}"`; per-entry fields are addressed by `getByLabel` via the newly wired `htmlFor`/`id` (`entry-{section}-{id}-{field}`); bullet textareas via `data-testid="bullet-{id}"`; the save status span via `data-testid="save-status"`; version rows via `data-testid="version-row"`.
- Autosave wait: `page.waitForResponse(resp => resp.url().includes('/api/profile/entries/') && resp.request().method() === 'PATCH')` — never fixed sleeps (FR-009).
- The duplicate-skill dialog is awaited via `page.getByRole('dialog')` (`aria-label="Duplicate skill"`); outcomes: `Keep existing` button, or Escape → rename → save.

## API assertions used by specs (existing routes, unchanged)

- `GET /api/profile` → `{ profile: { version, language, experience, education, skills, languages, projects, certifications, ... }, lowConfidenceCount }` — persisted-state checks after reload.
- `GET /api/profile/versions` → `{ currentVersion, versions: [{ version, cause, createdAt }] }` — FR-010's exact-count + cause assertions.
- `POST /api/profile/entries/[section]` response `warnings` — the `DATE_RANGE_OVERLAP` assertion (FR-007; UI display is a documented product gap, research R6).
- `POST /api/validation/claims` → `{ flags: [{code, claim, severity, affectedFieldIds, ...}], summary }` — FR-011: clean profile ⇒ zero blockers; inconsistent fixture ⇒ `INCONSISTENT_STATE` warning visible with machine-readable code.
