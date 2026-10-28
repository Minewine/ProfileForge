# GUI Test Run Status — 2026-10-28 (~07:00 local)

Testing ProfileForge at http://localhost:3000 via in-app browser, using
`CV/COUGHLAN_CV_2024_EN.pdf` as input. Stopped mid-run at user request
(computer shutdown). Resume from "Next steps" below.

## Completed

- **T1 Login — PASS.** `mtcoughlan@gmail.com` / password works; redirects to `/profile`.
  (Note: bare username `mtcoughlan` is rejected by native email-input validation —
  the full address is required. Screenshot: `t1_login_email_validation_error.png`.)
- **T2 Upload → extract → parse → import — PASS at the feature level.**
  PDF text extraction worked ("2 pages · 2,658 characters extracted"), AI parse
  produced an accurate draft (Michael Coughlan + 5 experience entries with bullets,
  2 `ambiguous_date` review flags on education), and Import reported success
  (profile v2 via merge, v3 via replace).
  Parsing is slow on the current free model (~50s–2.5min per call).
- **T3 Profile contents — FAIL (see Bug 1).**

## Bugs found (severity order)

1. **P0 — FIXED 2026-10-28: CV import loses all experience/education/skills entries.**
   Root cause was not the import write: `getOrCreateProfile` had a findFirst→create
   race with no unique constraint on `Profile.userId`, producing two profile rows
   (basics went to one, imported entries to the other; the editor read the
   basics-only row). Fix: unique index on `Profile.userId` (migration
   `20261028070000_unique_profile_per_user`, which also collapses duplicates —
   keeps the profile with the most entries, rescues basics onto it) +
   race-safe/deterministic `getOrCreateProfile` + `scripts/assign-owner.ts` guard.
   Regression tests in `tests/integration/profile-repository.test.ts`
   ("one profile per user" block). Verified: dev DB repaired (5 experience /
   2 education / 9 skills visible in the editor alongside basics).
2. **P1 — FIXED 2026-10-28: Imported links are mangled.** `www.linkedin.com/in/coughlan` became
   `www.linkedin.com:in/coughlan` and `www.rametric.com` became
   `www.rametric.com:www.rametric.com`. Root cause was NOT PDF extraction (re-extraction is clean):
   the parse LLM emitted the garbage and two validation holes let it through — zod's `.url()` accepts
   scheme-only strings like `www.rametric.com:www.rametric.com` (parsed as scheme "www.rametric.com")
   while rejecting legitimate scheme-less links, and the parse draft's `projects[].link` was a loose
   unvalidated string that `insertEntry` writes verbatim. Fix: shared `HttpUrlSchema`/`normalizeLink`
   in `validation/schemas.ts` — scheme-less links normalize to `https://`, non-recoverable values are
   dropped (never fatal to a parse/save); applied to `BasicsSchema.links` (dropping), the project
   input/patch schemas (strict 400), and `prepareDraft`'s import payloads. Regression tests:
   `tests/unit/link-validation.test.ts`.
3. **P1 — `LLM_UNAVAILABLE` banner masks the real error.** Server log showed the
   configured economy model `minimax/minimax-m3.1-flash:free` was retired
   (OpenRouter HTTP 404, free period ended 2026-10-22), but the UI said only
   "AI provider is temporarily unavailable".
4. **P1 — OpenRouter account has zero credits** (HTTP 402 "never purchased
   credits"). Any paid model (incl. configured premium `anthropic/claude-sonnet-4.5`)
   fails with `LLM_QUOTA`. Generation (T6) will likely hit this unless it uses a
   free model.
5. **P2 — Upload state is client-only.** The "work so far is preserved" claim
   holds across client-side navigation but NOT across a hard reload — extracted
   text and draft were lost after `reload()` on another tab.
6. **P2 — Economy-model field garbles fast typing** (combobox suggestion
   re-render appears to reset cursor mid-input; `fill()` works, rapid `type()`
   interleaves characters). Possibly exaggerated by automation speed — needs
   human confirmation.

## Environment changes made during testing (disclosed)

- **Settings → Economy model** changed from `minimax/minimax-m3.1-flash:free`
  (retired upstream) to `nvidia/nemotron-3.5-super-vl:free` (free, structured-output
  capable). This is why parsing works now.
- Premium model and API key untouched. Screenshots in `gui-test-screenshots/`
  (today's files: `t1_login_page.png`, `t1_login_email_validation_error.png`,
  `t2_file_attached.png`, `t2_llm_unavailable_error.png`, `t2_llm_quota_error.png`,
  `t2_parsing_state.png`, `t2_file_attached_by_user.png`,
  `t3_profile_v2_basics_only_empty_experience.png`; older files are from a
  previous run). Note: full-page screenshots from the in-app browser show a
  repeated-content stitching artifact — DOM shows single copy, so not an app bug.
- File-picker note: the automation runtime cannot drive the native OS file
  dialog; the file was attached via the dialog by the user (T2 attempts) and
  earlier via DevTools-style injection into the app's file input (disclosed,
  app flow still exercised through real buttons).

## Next steps (resume here)

1. ~~Fix Bug 1~~ DONE (see above).
2. T4: edit one field + add a bullet in `/profile`, hard reload, verify persistence.
3. T5: `/jobs` — paste a short job description, run matching.
4. T6: generate CV + download; watch for `LLM_QUOTA` if generation uses the
   premium model.

## Blockers

- OpenRouter account has no purchased credits — only `:free` models usable;
  free-tier models are slow and can be retired without notice (Bug 3/4).
- Native file dialog needs one manual click per upload attempt (runtime
  limitation, not an app bug).
