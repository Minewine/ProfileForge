# Tasks: ProfileForge Slice 2 — JD Analysis & Deterministic Matching

**Input**: Design documents from `/specs/002-jd-matching/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md)

**Slice scope** (per spec.md): JD paste + language detection → LLM requirement extraction → user requirement review → deterministic match (exact → approved-alias → semantic, evidence-validated) → persisted MatchReport with history and re-run. **No CV/cover-letter generation (Slice 3).**

**Tests**: included, written FIRST and failing before implementation (project convention; the deterministic engine and score are table-driven pure functions — SC-004/SC-005 live there).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1 (paste/extract/review), US2 (deterministic match + report), US3 (history/re-run); setup/foundational/polish unlabeled

---

## Phase 1: Setup (shared groundwork)

- [x] T001 Extract the normalization function into `src/lib/text/normalize.ts` (NFKD → strip combining marks → lowercase → non-alphanumerics to spaces → collapse/trim), re-export from `src/lib/files/storage.ts` for backwards compatibility, and switch existing callers to the shared import — one definition of "normalized" is load-bearing for exact matching (R1)
- [x] T002 [P] Create `src/lib/jobs/schemas.ts` — zod shapes per contracts + data-model: JobCreateSchema (`text` 200..100,000 chars), language enum, RequirementInputSchema (`text` 1..500, `category` enum `skill|tool|years_experience|education|domain|language|other`, `importance` `must|nice`, `isHardConstraint` bool), RequirementsPutSchema (`{ requirements[], finalize: boolean }`), MatchReportSchema (overallScore int 0–100; scoreBreakdown incl. hardWeight/preferredWeight/evidenceBonus; RequirementMatch[] with status `strong|partial|gap`, matchMethod `exact|approved_alias|semantic|none`, evidence EvidenceRef[], note?, userConfirmed?; recommendedKeywords[]; missingKeywords[]; semanticDropped)

---

## Phase 2: Foundational (blocking prerequisites)

- [x] T003 Add Prisma models + migration: `JobAnalysis` (jdText, language `fr|en`, languageManuallyCorrected bool, status `created|extracted|finalized|matched|failed`, statusError?, profileVersion int?, matchReport JsonB?, semanticDropped int default 0, notice?, rerunOfId self-FK nullable, timestamps) and `JobRequirement` (analysisId cascade, text 1..500, category, importance `must|nice`, isHardConstraint bool, order int, source `extracted|user`, userConfirmed bool default false) in `prisma/schema.prisma`; `npx prisma migrate dev --name jobs_analysis`
- [x] T004 Implement `src/lib/jobs/repository.ts`: createAnalysis (length guards → `JD_TOO_SHORT`/`JD_TOO_LONG`), listAnalyses (id/status/language/createdAt/overallScore?/requirementCount/title=first 60 chars/rerunOfId), getAnalysis (requirements + report), updateLanguage (blocked when status `matched`), deleteAnalysis (cascade), replaceRequirements (full-list replace; **preserve `userConfirmed` by text+category match**; `finalize` transitions extracted→finalized), persistReport (pins current profile version; refuses to overwrite an existing report unless `recompute: true`), markFailed(statusError), rerunAnalysis (new row: copies jdText/language/finalized requirements incl. confirmations, status `finalized`, rerunOfId chain)
- [x] T005 Integration tests for the repository in `tests/integration/jobs-repository.test.ts`: state machine created→extracted→finalized→matched (and failed→retry), report immutability (second persistReport without recompute → error), rerun chain + confirmation preservation, delete cascade

**Checkpoint**: data layer ready — story work can begin.

---

## Phase 3: User Story 1 — Paste a JD and Extract Its Requirements (Priority: P1)

**Goal**: Paste FR/EN JD → language detected → LLM extraction → user reviews/corrects/finalizes the requirement list.
**Independent Test**: quickstart scenarios 1–2 + 10 (guards): create → extract (mocked/live) → edit requirements → finalize; language correction; length guards.

### Tests for User Story 1

- [x] T006 [P] [US1] Failing integration tests in `tests/integration/jobs-api.test.ts` (`callLLM` mocked): POST /api/jobs (150 chars → `JD_TOO_SHORT`, >100k → `JD_TOO_LONG`, FR text → language `fr`), PATCH language correction (and 409 after `matched`), extract (requirements stored with category/importance/hard flags, status `extracted`, re-extract replaces list → `replacedRequirements: true`), PUT requirements full-replace + finalize → `finalized`, match-before-finalize → 409 `INVALID_STATE`
- [x] T007 [P] [US1] Failing unit tests in `tests/unit/llm-jobs-tasks.test.ts`: `extractRequirements` task registered (name, tier economy), input schema ({text ≥50 chars, language}), output schema, and prompt carries the binding zero-invention constraints verbatim from contracts/llm-tasks.md

### Implementation for User Story 1

- [x] T008 [US1] Implement `src/lib/llm/tasks/extractrequirements.ts`: registerTask "extractRequirements" (economy tier; input `{text, language}`; output `{requirements: [...]}`; prompt: extract only explicitly stated requirements, verbatim text in JD language, must/nice by JD markers incl. "exigé/obligatoire" vs "atout/un plus", isHardConstraint only for required tools/certs/licenses/explicit years)
- [x] T009 [US1] Implement routes: `src/app/api/jobs/route.ts` (POST — franc detection reusing `@/lib/parsing/language`, 201 `{analysisId, language, languageLowConfidence, status}`; GET list) and `src/app/api/jobs/[id]/route.ts` (GET analysis, PATCH language while status ≠ `matched` else 409, DELETE → 204)
- [x] T010 [US1] Implement `src/app/api/jobs/[id]/extract/route.ts`: status guard (`created|extracted|failed`), callLLM with its own runId (cost cap), store requirements (`source: "extracted"`), transition to `extracted` or `failed` + `statusError`; response `{status, requirements, usage, replacedRequirements}`
- [x] T011 [US1] Implement `src/app/api/jobs/[id]/requirements/route.ts`: PUT full-list replace (RequirementsPutSchema), userConfirmed preservation, finalize transition, 409 on invalid status
- [x] T012 [US1] Build UI: `src/app/jobs/page.tsx` (paste box, history list with status badges + score chips) and `src/app/jobs/[id]/page.tsx` stages 1–2 (Extract button with loading state; requirement review editor: editable text/category/importance/hard flag, add/remove rows, ~800 ms debounced full-list PUT, Finalize; language correction select); add the /jobs link to the dashboard `src/app/page.tsx`

**Checkpoint**: paste → extract → review → finalize works end-to-end.

---

## Phase 4: User Story 2 — Deterministic Match & MatchReport (Priority: P1) 🎯 MVP core

**Goal**: Deterministic engine (exact → alias → validated semantic) assigns status/method/evidence per requirement; clarified score computed; report persisted, version-pinned, copyable.
**Independent Test**: quickstart scenarios 1 (report), 4 (hard-constraint honesty), 5 (evidence), 6 (semanticDropped), 9 (degraded semantic); engine/score unit tables green.

### Tests for User Story 2

- [x] T013 [P] [US2] Failing table-driven unit tests in `tests/unit/matching-engine.test.ts`: exact equality incl. accents/case (`Développeur Web` ≡ `developpeur web`), `skillsUsed` hits, built-in alias group match (k8s↔Kubernetes, gestion de projet↔project management), per-skill user-alias match, **non-approved synonym NOT matched**, free-text bullets never exact, hard constraints excluded from semantic, semantic proposals with unknown/empty entryIds dropped + counted, partial (term matched, no usage evidence → 0.5) vs strong (with `skillsUsed`/bullet evidence), credential/education/language categories strong on existence, keywords derived must>nice
- [x] T014 [P] [US2] Failing unit tests in `tests/unit/score.test.ts`: formula table (credits 1.0/0.9/0.7/0.5/0), semantic credit never applied to hard, empty-bucket shift (0 hard → preferred weighted 90; both empty → evidenceBonus only), evidenceBonus = 10 × share of matched reqs with experience/project-bullet EvidenceRef, integer rounding, and **recomputation from frozen fixtures yields identical overallScore + breakdown (SC-004)**
- [x] T015 [P] [US2] Add `semanticProposals` cases to `tests/unit/llm-jobs-tasks.test.ts`: registration (economy), input ({language, requirements with index — non-hard only enforced by caller, profileDigest}), output proposals `{requirementIndex, entryIds, rationale?}`, prompt's cite-exact-IDs / no-proposal-beats-wrong-proposal constraints

### Implementation for User Story 2

- [x] T016 [P] [US2] Implement `src/lib/matching/aliases.ts`: `BUILTIN_ALIASES` (~60 vetted bilingual groups incl. k8s↔kubernetes, gestion de projet↔project management, react.js↔react) + `ALIAS_LIST_VERSION`; `sameAliasGroup(a, b, profile)` resolving over built-in groups ∪ per-skill `Skill.aliases` — nothing else is an alias (parent FR-007)
- [x] T017 [P] [US2] Implement `src/lib/matching/score.ts` as a pure function per contracts/matching-engine.md: hard 60 + preferred 30 + evidence bonus 0–10, per-requirement credits, empty-bucket weight shift, bonus = 10 × bullet-evidence share, round; export `scoreFromMatches` for recomputation
- [x] T018 [P] [US2] Implement `src/lib/matching/digest.ts`: pinned ProfileDto → capped (~120, recency-ordered) `{id, type: skill|bullet|education|certification, text}` digest
- [x] T019 [P] [US2] Implement `src/lib/llm/tasks/semanticproposals.ts`: registerTask "semanticProposals" (economy; input per contract; output proposals; binding prompt: cite exact entry IDs, no proposal beats a wrong one)
- [x] T020 [US2] Implement `src/lib/matching/engine.ts`: exact layer (structured fields only — Skill.name, Certification.title, Experience.skillsUsed[], LanguageSkill.name), alias layer, semantic validation (drop invalid entryIds → semanticDropped counter; EvidenceRefs built server-side from real entries — LLM never writes evidence text), statuses per the R3 table (strong/partial/gap with credits), years-experience notes, recommended/missing keywords; pure — no LLM calls inside
- [x] T021 [US2] Implement `src/app/api/jobs/[id]/match/route.ts`: guard `finalized` (or `matched` + explicit `{recompute: true}`, else 409 nudging to rerun); pin profile snapshot; run engine exact/alias → semantic task (shared runId for the run under the cost cap); on semantic failure produce the **degraded exact/alias-only report with `notice`** (FR-014) — never blocks, never fabricates; validate proposals → statuses/credits/score → `persistReport(profileVersion)`; response `{status: "matched", report, profileVersion, usage, semanticDropped}`
- [x] T022 [US2] Implement `src/app/api/jobs/[id]/confirm/route.ts`: `{requirementId}` — allowed only when the engine recorded a semantic proposal for that hard constraint (evidence-gated, else 422); flips the stored entry to `{matchMethod: "semantic", status: "strong", userConfirmed: true}`, recomputes + persists the score
- [x] T023 [US2] Build the report view (stage 3) in `src/app/jobs/[id]/page.tsx`: score + breakdown chips (incl. effective weights + evidence bonus), per-requirement cards (status/method badges, evidence entries with snippets — drill-down, notes), confirm button on hard-constraint semantic candidates presented as gaps, recommended/missing keywords, `semanticDropped` metric, copy-report-as-text button, re-run button (enabled after match)

**Checkpoint**: full analyze flow — paste → extract → review → match → evidence-backed report. Demoable MVP with US1.

---

## Phase 5: User Story 3 — History & Re-run (Priority: P2)

**Goal**: Analyses persist immutably; re-run chains a new analysis against the current profile version; old reports never change silently.
**Independent Test**: quickstart scenario 8 — edit profile, re-run, new analysis scores the update, old report keeps its numbers and pinned version.

### Tests + Implementation for User Story 3

- [x] T024 [US3] Failing integration tests (extend `tests/integration/jobs-api.test.ts`): rerun creates a chained analysis (`rerunOfId`, requirements + confirmations copied, status `finalized`), original report unchanged after rerun+match, delete cascades
- [x] T025 [US3] Implement `src/app/api/jobs/[id]/rerun/route.ts`: guard `matched`; 201 `{analysisId}` (client redirects)
- [x] T026 [US3] History polish in `src/app/jobs/page.tsx`: rerun-chain indicator (linked titles), delete with confirmation, sort by updatedAt; `/jobs/[id]` shows "pinned to profile vN" on stored reports

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T027 Full validation: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build` — all green
- [x] T028 Live quickstart pass (scenarios 1–10) with the real key against the dev server — incl. cross-language JD↔profile, hard-constraint honesty check, degraded-semantic via a temporarily invalid economy model (restored after); protect user data (reports are additive; no profile mutation in this slice)
- [x] T029 [P] Update `README.md` (What works today, tests) and add the /jobs link to the dashboard if not already present

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** → **Foundational (Phase 2)** → stories.
- **US1 (Phase 3)** depends on Phase 2 (repository) + router (exists). T008–T011 sequential-ish (routes use repository + task); T012 after routes.
- **US2 (Phase 4)** depends on US1's schemas/task pattern; engine tasks T016–T019 are parallel pure modules; T020 (engine) after T016; T021 orchestration after T020; T022/T023 after T021.
- **US3 (Phase 5)** depends on US2 (matched analyses exist).
- **Polish (Phase 6)** last.

### Parallel Opportunities

- T002 parallel with T001; T006/T007 test files parallel; T013/T014/T015 parallel test files; T016–T019 are independent files (engine imports aliases but files can be authored in parallel); T029 anytime after T012.

---

## Implementation Strategy

### MVP First (Phases 1–4)

1. Setup + Foundational (data layer) → validate with repository tests.
2. US1 (paste/extract/review) → validate quickstart 1–2, 10.
3. US2 (match/report) → **STOP and VALIDATE** — engine/score tables + quickstart 1, 4, 5, 6, 9. This is the demoable MVP.
4. US3 (history/rerun) → quickstart 8.
5. Polish → full validation + README.

---

## Notes

- Tests FIRST and failing before implementation; engine + score are pure functions — their tables are the contract (SC-004/SC-005 enforced there).
- The LLM never writes evidence text; EvidenceRefs are always built server-side from real entries.
- Hard constraints: semantic never satisfies them; confirmation is evidence-gated (FR-007).
- Semantic-step failure degrades to exact/alias-only with a notice — never blocks, never fabricates (FR-014).
- One runId per match run (engine+semantic under the same cap); extract has its own.
- Stored reports are immutable; changes require explicit recompute or a re-run (new row).
