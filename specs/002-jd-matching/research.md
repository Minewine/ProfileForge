# Research: Slice 2 — JD Analysis & Deterministic Matching

**Date**: 2026-10-21 · All Technical Context unknowns resolved; foundation decisions (npm 11 install dance, vitest 4, Prisma 7 patterns, zod 4 constraints, cacheComponents/Suspense and `connection()` requirements) carry over from Slice 1 unchanged.

## R1: Shared normalization — one function, everywhere

- **Decision**: extract Slice 1's `normalizeName` from `src/lib/files/storage.ts` into `src/lib/text/normalize.ts` (NFKD → strip combining marks → lowercase → non-alphanumerics to spaces → collapse/trim) and re-export from the old location. The matching engine, alias resolution, and duplicate-skill detection all use this single function — exact matching is literally "normalized equality", so one definition of "normalized" is load-bearing (FR-004, cross-language FR-013).
- **Rationale**: divergent normalizers would let the same string match in one layer and not another; the accent-stripping rule is also what makes `Développeur Web` ≡ `developpeur web` work cross-language.
- **Alternatives considered**: NFKC-only folding (keeps accents, breaks FR/EN equivalence); ICU collation (no need — equality, not sorting).

## R2: Exact-match granularity — structured fields only

- **Decision**: exact matches compare the normalized requirement text against **structured profile fields**: `Skill.name`, `Certification.title`, `Experience.skillsUsed[]` entries (and LanguageSkill names for language requirements). Free-text bullets are *not* exact-match candidates — bullet content is semantic-layer evidence.
- **Rationale**: the parent contract says exact = "normalized string match of a hard skill, tool, certification, or credential" — a structured, auditable comparison. Substring hunting in prose is exactly where false positives (and invented equivalence) creep in; prose belongs to the evidence-validated semantic layer.
- **Alternatives considered**: token-subset matching inside bullets (rejected: not deterministic-auditable, prone to false "exact" hits); whole-phrase equality only on skills (rejected: `skillsUsed` is equally structured and covers roles where the skill list wasn't filled).

## R3: Partial status — deterministic definition

- **Decision**: `partial` (credit 0.5) is assigned deterministically when the best matching layer found the **term** (exact or alias) in a structured field, but the profile shows **no usage evidence**: the skill exists yet appears in no experience/project bullets or `skillsUsed`, and the requirement is experience-flavored (skill/tool categories). `strong` = term matched AND usage evidence exists (or the requirement is a credential/education/language category where existence is the evidence). Semantic proposals, when valid, yield `strong` with method `semantic` (credit 0.7).
- **Rationale**: the clarified formula prices partial at 0.5 without defining it; this definition is pure code (no LLM judgment), testable, and matches the product promise: listing a skill ≠ having used it.
- **Alternatives considered**: LLM-graded partial/strong (rejected: nondeterministic); partial only for years-of-experience shortfalls (kept as a gap-level `note`, not a status — comparing "5 years required" to computed tenure is Slice-3-adjacent tuning and can be added to the note field without schema change).

## R4: Semantic layer — propose–validate split

- **Decision**: new registry task `semanticProposals` (economy tier): input = non-hard requirements + a **profile digest** (id, type, text snippet per entry, capped at the most recent ~120 entries); output = proposals `{requirementIndex, entryIds[], rationale?}`. The deterministic engine then validates every proposal (entryIds must exist and be non-empty), drops invalid ones (counted in `semanticDropped`), and converts survivors into semantic matches with EvidenceRefs built server-side from the real entries — the LLM never fabricates evidence text, it only points at IDs.
- **Rationale**: satisfies "LLM-assisted … must cite evidence" and SC-005 (100% of invalid proposals dropped) while keeping every number in the report computed by code. This is the deterministic split of the source doc's `generateMatchReport` task (documented in contracts/llm-tasks.md).
- **Alternatives considered**: embeddings + cosine threshold (rejected for this slice: new infra, threshold tuning, and still needs evidence validation); one combined extract+match LLM call (rejected: extraction must be reviewable before matching — parent FR-012).

## R5: Alias seed — versioned code file, bilingual, conservative

- **Decision**: `src/lib/matching/aliases.ts` exports `BUILTIN_ALIASES` — a hand-vetted seed (~60 pairs at ship) of canonical FR/EN tech and role equivalents (`k8s ↔ kubernetes`, `gestion de projet ↔ project management`, `react.js ↔ react`, …) as bidirectional groups, with a `ALIAS_LIST_VERSION` constant. Resolution: a requirement term matches by alias if its normalized form and a profile term's normalized form land in the same group, or the profile skill's user-approved `aliases[]` links them. No runtime mutation; list changes ship with the app.
- **Rationale**: "versioned built-in global list shipped with the application" (parent FR-007) — a source file is versioned by definition, diffable in review, and trivially testable. Conservative sizing avoids implying coverage we haven't vetted; users extend via per-skill aliases by design.
- **Alternatives considered**: DB-seeded table (adds migration/UI surface for zero user value in this slice); importing a public synonym dataset (unvetted synonyms would violate approved-only).

## R6: Persistence — two models, report as JSONB

- **Decision**: `JobAnalysis` (jdText ≤100k chars, language, `languageManuallyCorrected`, status machine `created → extracted → finalized → matched | failed`, `profileVersion` (nullable until match), `matchReport` JSONB, `semanticDropped` int, `notice` text?, `rerunOfId` self-FK nullable) + `JobRequirement` rows (text, category enum, importance, `isHardConstraint`, order, `source: extracted|user`, `userConfirmed` bool for hard-constraint confirmations). Re-run creates a **new** JobAnalysis copying the finalized requirements and pinning the current profile version; both stay in history.
- **Rationale**: requirements are user-editable rows (review is a first-class flow); the report is an immutable snapshot — JSONB keeps the canonical §4 shape exactly and recomputing the score from it (SC-004) is a pure read. Self-FK gives provenance chains for re-runs without duplicating text drift.
- **Alternatives considered**: normalized RequirementMatch/EvidenceRef tables (rejected: report is read-only once written; JSONB matches the canonical interface and keeps queries simple); mutating a single analysis on re-run (violates "stored reports never change silently").

## R7: Statuses & flow guards

- **Decision**: match is only runnable in status `finalized` (requirements reviewed) or re-runnable on `matched` analyses via the rerun endpoint; extract is idempotent-replaceable on `created|extracted` (re-extraction replaces the requirement list, resetting user edits — with that consequence stated in the response). Language correction allowed until `matched` (after match, re-extract or re-run instead). JD length: refuse > 100,000 chars (`VALIDATION_ERROR`, no silent truncation); minimum 200 chars per spec.
- **Rationale**: mirrors Slice 1's guard style (CONFIRMATION_REQUIRED etc.) and keeps the state machine honest; re-extract-after-review is the one destructive-but-recoverable action (requirement edits are cheap to redo, and the previous list can be re-extracted).
- **Alternatives considered**: versioned requirement lists per extraction (over-engineering for MVP; the analysis history itself provides the audit trail).

## R8: Cost cap & run grouping

- **Decision**: each user-visible run (extract; match incl. its semantic call) uses its own runId so the per-run cap applies per action, and both LLM calls in a match share one runId (engine + semantic is one logical run). Usage surfaces through the existing Settings usage list.
- **Rationale**: parent FR-008/FR-015; the existing `checkRunCap`/`recordUsage` machinery needs only correct runId plumbing.
- **Alternatives considered**: one runId for the whole analysis lifetime (rejected: a cap hit on match would then also block later re-extracts).

## R9: UI shape

- **Decision**: `/jobs` (paste box + history list with score chips + status) and `/jobs/[id]` wizard with three staged sections (Extract → Requirements review → Report) whose visibility follows the analysis status. Report view: score + breakdown chips, per-requirement cards (status/method badges, evidence entries with snippets, confirm button on hard-constraint semantic candidates presented as gaps, notes), recommended/missing keywords, copy-as-text button, re-run button. Requirement review: editable rows (text/category/importance/hard flag) + add/remove, mirroring the profile editor's autosave pattern (debounced PUT full list).
- **Rationale**: reuses established UI idioms (cards, badges, debounced saves); staging by status prevents invalid orderings at the UI level. Copyable text is generated client-side from the report JSON (single source of truth).
- **Alternatives considered**: single-page with tabs (rejected: the flow is strictly sequential); server-rendered report page (kept client for copy button simplicity; data already persisted).
