# Quickstart — Profile Editing E2E Suite

## One-time setup

```bash
npm install                 # picks up @playwright/test (devDependency)
npm run e2e:install         # chromium browser binary
docker compose up -d e2e-db # dedicated Postgres on :5434 (or let test:e2e start it)
```

## Run

```bash
npm run test:e2e
```

What happens: `e2e-db` ensured → schema reset + migrated (e2e DB only; the script aborts if `DATABASE_URL` does not point at `profileforge_e2e`) → `next build && next start` on :3100 with e2e env → fixtures seeded through the app's own routes → 6 spec files run serially (seed/display → experience CRUD → sections CRUD → autosave → versions → provenance/claims) → server stops. Consecutive runs need no manual cleanup (SC-003).

## Scenario map (spec traceability)

| Spec file | Story | Asserts |
|---|---|---|
| `seed-and-display.spec.ts` | US1 | all seeded entries visible per section; provenance badges; FR accents round-trip |
| `experience-crud.spec.ts` | US2 | add/edit/remove entry; title edit; bullet add/edit/remove; gone after reload |
| `sections-crud.spec.ts` | US3 | CRUD in languages/skills/education/projects/certifications; duplicate-skill dialog (keep + rename branches); overlap warning (API); level-less skill stays level-less |
| `autosave-persistence.spec.ts` | US4 | edit → PATCH response → reload ⇒ persisted; abandoned edit ⇒ prior value |
| `version-history.spec.ts` | US5 | N edits ⇒ version +N; causes recorded; history survives reload |
| `provenance-claims.spec.ts` | US6 | created entries user-entered; edits stay attributed; clean validation = 0 blockers; inconsistent fixture ⇒ `INCONSISTENT_STATE` flag with code |

## Debugging

- `npx playwright test --headed` / `--debug` — step through a scenario.
- `npx playwright test tests/e2e/sections-crud.spec.ts -g "duplicate"` — one scenario.
- `tests/e2e/.seed-state.json` — the ids the current seed produced.
- Traces/screenshots on failure land in `test-results/` / `playwright-report/` (`npx playwright show-report`).

## Isolation guarantees (what "safe" means here)

- The suite talks only to `profileforge_e2e` (port 5434) and `./uploads-e2e`; the app under test runs with overridden env on :3100.
- The reset script refuses to run against any other database (abort before any mutation, FR-001).
- SC-004 check: the seed script prints the main DB's `Profile.version` + table counts before and after; a full run leaves them identical.

## Success criteria

- SC-001: full run < 5 min · SC-002: every section × operation cell covered · SC-003: 3 consecutive clean runs · SC-004: main DB untouched · SC-005: an injected regression (e.g. autosave PATCH disabled) fails the matching scenario with an actionable message — verified once during polish · SC-006: every failure names scenario + operation + assertion.

## Proof record (2026-10-24, T016/T017)

- **SC-005 (injected regression)**: with autosave temporarily disabled (one env-gated `return` in the editor's `schedule()`), the suite failed 6 scenarios in 3 spec files — both US4 tests ("edit confirmed at the network level survives reload" → 10 s `waitForResponse` timeout; "basics edits autosave…"), US2's bullet-edit step, US3's field-edit steps, and US5's version counting — each with the scenario name, operation, and assertion visible. Code reverted; suite green again (14/14).
- **SC-003 (deterministic reset)**: three consecutive `npm run test:e2e` runs with no manual cleanup — 14/14, 14/14, 14/14 (49 s / 44 s / 35 s).
- **SC-004 (main DB untouched)**: the reset script's printed baseline (`Profile.version = 29`, per-table counts) was identical before every run; the main database is never touched (abort guard + runtime canonical-row guard).
- **SC-001**: full runs land between 35–50 s including build, reset, seed, and 14 scenarios — well inside the 5-minute budget.
