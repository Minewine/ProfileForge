# Data Model — Profile Editing E2E Test Suite

This feature adds no product entities. Its "data" is the fixture set the suite seeds and the isolation context it runs in. Canonical product schemas remain `ProfileForge-Specification.md` §4 and `src/lib/validation/schemas.ts` (the explorer brief quotes the exact input schemas the fixtures must satisfy).

## Fixture Set (`tests/e2e/fixtures/profile.ts`)

All fixture content is plain data satisfying the existing `CreateSchemas`/`BasicsSchema` field lists (quoted in research R-brief §8). Shapes:

```ts
type ProfileFixture = {
  basics: { name; headline; location; email; phone; summary };  // BasicsSchema fields
  language: "en";
  experience: Array<{ company; title; location?; startDate; endDate; skillsUsed[]; bullets: string[] }>;
  education:  Array<{ institution; degree; field; startDate; endDate; grade? }>;
  skills:     Array<{ name; category?; level?; aliases? }>;      // level user-stated only; aliases approved-only
  languages:  Array<{ name; proficiency? }>;
  projects:   Array<{ name; description; link?; startDate; endDate; bullets: string[] }>;
  certifications: Array<{ title; issuer; issueDate }>;
};

type SeedState = {   // written to seed-state.json; specs read ids/versions from it
  profileVersionAfterSeed: number;
  entryIds: Record<section, string[]>;
  inconsistent: { section: "experience"; entryId: string; bulletText: string }; // pg-written flag fixture
  duplicateSkillName: string;  // pre-seeded so the 409 dialog scenario is deterministic
};
```

Content rules (FR-003):
- **EN primary**: full sections (≥2 experience entries with distinct date ranges, education, skills incl. one with a stated level and one without, languages, a project with bullets, certifications). Names/dates deterministic constants.
- **FR bilingual case**: one experience entry with accented text (é/è/ç) and French content, plus the profile language field exercised via the editor's language select.
- **Inconsistent fixture**: an otherwise-valid `user_entered` experience bullet that `seed.mjs` post-writes via `pg` to carry `reviewFlag = "containment_failed"` — the only editor-unreachable state, producing `INCONSISTENT_STATE` (warning) from `validateProfileClaims`. The clean-run assertion (zero blockers) must run before this fixture is written, or the fixture must be removed after its scenario (seed writes it last; its spec is ordered last).
- **Duplicate-skill seed**: one skill whose exact name a later scenario re-adds to trigger the 409 → dialog path deterministically.

## Isolation Context

| Element | Value | Enforcement |
|---|---|---|
| e2e Postgres | compose `e2e-db`, port **5434**, db `profileforge_e2e`, own volume | `reset-db.mjs` abort guard: `DATABASE_URL` must contain `profileforge_e2e` |
| Uploads dir | `./uploads-e2e` (gitignored) | env override on the server under test |
| App under test | `next start -p 3100` (production build) | Playwright `webServer`, env overrides per run |
| Reset | `DROP SCHEMA public CASCADE` + `prisma migrate deploy` (e2e URL only) | every run, before seeding (FR-013) |
| Main DB | untouched by construction | SC-004 check prints main `Profile.version` + table counts before/after |

## State machine (per run)

```text
ensure e2e-db → reset schema → migrate → start app (webServer) → seed via HTTP
  → [seed-state.json] → spec order: seed-and-display → experience-crud → sections-crud
  → autosave → version-history → provenance-claims (inconsistent fixture last) → server stop
```

Serial, ordered execution is deliberate: scenarios build on the seeded state and the inconsistent fixture must not pollute the clean-report scenario.

## Validation rules (cross-cutting)

- Fixture payloads MUST pass the existing `CreateSchemas` (the seeder asserts 201s; any 400 fails setup loudly — fixture drift surfaces at seed time, per the spec's edge case).
- Dates in fixtures MUST match `YYYY-MM` / `"present"` (`YearMonthSchema`/`EndDateSchema`).
- Skill fixture without `level` MUST stay level-less after round-trip (FR-008 assertion source).
- The inconsistent fixture MUST be the only direct-DB write in the harness.
