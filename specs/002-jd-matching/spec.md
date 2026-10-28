# Feature Specification: ProfileForge Slice 2 — Job Description Analysis & Deterministic Matching

**Feature Branch**: `002-jd-matching`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Slice 2: Job Description analysis + deterministic matching. Scope: user pastes a job description; system extracts requirements (must/nice, hard constraints) via LLM; deterministic matching against the Profile (exact, approved-alias, semantic) producing a MatchReport with overallScore, scoreBreakdown, RequirementMatch entries with EvidenceRef, recommended and missing keywords; evidence-aware (every match points at concrete profile entries); no CV or cover letter generation in this slice (Slice 3)."

**Parent specification**: This slice implements stories/requirements of [specs/001-ats-cv-tailoring/spec.md](../001-ats-cv-tailoring/spec.md) (US4 and FR-010 through FR-014, FR-030) and the canonical schemas/contracts of `ProfileForge-Specification.md` §4–§6 (`analyzeJob(jdText, profile) → MatchReport`, `extractRequirements`, `generateMatchReport`). Where wording differs, the parent spec and the clarified decisions recorded in `001/Clarifications (Session 2026-10-21)` govern: the score formula, alias governance, and threshold decisions are settled and are restated here as binding.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Paste a Job Description and Extract Its Requirements (Priority: P1)

The user pastes a job description (French or English) into the application. The system detects the JD's language (stored, user-correctable), validates that the text is long enough to analyze, and uses the user's OpenRouter key to extract a structured requirement list: each requirement with its text (in the JD's language), a category (skill, tool, years of experience, education, domain, language, other), an importance level (must-have vs. nice-to-have — recognizing French markers such as "exigé/obligatoire" vs. "atout/un plus"), and a hard-constraint flag (required tools, certifications, licenses, explicit years of experience). The user reviews the extracted list and can correct, remove, or add requirements before anything is matched — extraction is assistance, not authority.

**Why this priority**: Requirement extraction is the input to everything else in the slice, and the review step (parent FR-012) is what makes the eventual report trustworthy.

**Independent Test**: Paste a known JD; verify every extracted requirement carries category, importance, and hard-constraint flag; edit one requirement and delete another; the corrected list is what gets matched.

**Acceptance Scenarios**:

1. **Given** a configured AI key and a pasted JD of sufficient length, **When** the user runs extraction, **Then** a structured requirement list is produced with text, category, importance (must/nice), and hard-constraint flag for every entry.
2. **Given** a French JD, **When** extracted, **Then** must/nice classification recognizes French phrasing and requirement text is kept in French.
3. **Given** the extracted list, **When** the user corrects, removes, or adds requirements, **Then** the corrected list is stored and used for matching.
4. **Given** a JD shorter than the minimum length, **When** submitted, **Then** a clear error asks for the full text — no empty or invented requirement list.
5. **Given** the detected JD language is wrong, **When** the user corrects it, **Then** the stored language updates and downstream processing uses the corrected value.

---

### User Story 2 — Run the Deterministic Match and Read the MatchReport (Priority: P1)

With a finalized requirement list, the system matches every requirement against the profile and produces a MatchReport. Matching follows the deterministic ordered contract: **exact** (normalized, case- and accent-insensitive string comparison), then **approved alias** (the union of the versioned built-in bilingual global list and the user's per-skill approved aliases — nothing else counts), then **semantic** (LLM-assisted, non-hard requirements only). Every semantic proposal must cite concrete profile entries; a deterministic validator drops any proposal whose evidence references do not exist. Each requirement gets a status (strong / partial / gap), a match method, and — for matches — evidence references pointing at specific profile entries. The report shows the overall 0–100 score with its reproducible breakdown, recommended keywords, and missing keywords; gaps are listed clearly, never hidden. The report doubles as interview-prep material and is copyable.

**Why this priority**: The MatchReport is the decision-making heart of the product (parent US4): honest fit assessment, evidence-backed, reproducible.

**Independent Test**: Given a fixed requirement list and a pinned profile version, matching runs and the report accounts for 100% of requirements with status, method, and evidence-or-gap; recomputing the score from the stored match set yields the identical result.

**Acceptance Scenarios**:

1. **Given** a finalized requirement list, **When** the user runs the match, **Then** every requirement appears in the report with status (strong/partial/gap), match method (exact / approved alias / semantic / none), and evidence references for matches.
2. **Given** a requirement stating a hard constraint with no exact or approved-alias match, **When** the report is produced, **Then** it remains a gap — semantic resemblance alone never satisfies it unless the user explicitly confirms it (confirmation recorded as user-confirmed).
3. **Given** a semantic proposal citing a profile entry that does not exist, **When** validation runs, **Then** the proposal is dropped (never shown as a match) and the requirement is scored from the remaining layers.
4. **Given** a JD in one language and a profile in the other (e.g., English JD, French profile), **When** matching runs, **Then** exact/alias matching still applies via bilingual normalization and the bilingual alias list — the language difference alone does not create a false gap.
5. **Given** the completed report, **When** the user views it, **Then** the overall score, its breakdown (hard met, preferred met, exact/alias/semantic counts), recommended keywords, and missing keywords are all visible, and the whole report is copyable.
6. **Given** the report, **When** unmet requirements exist, **Then** gaps and missing keywords are listed clearly, and every gap is honest (no fabricated evidence).

---

### User Story 3 — Keep and Re-run Analyses Against an Evolving Profile (Priority: P2)

Each analysis is persisted: the JD text, its language, the (possibly user-corrected) requirement list, and the resulting MatchReport are stored together, pinned to the profile version they were produced from. The user sees their analysis history, can reopen any report (its numbers never silently change), and can re-run an analysis against the current profile — which pins the new current version and produces a fresh report. This makes the report comparable over time and keeps provenance intact when the profile changes later.

**Why this priority**: Persistence and version pinning (parent FR-027) make reports trustworthy and comparable; re-analysis is how the user measures the effect of enriching their profile. The core flow (US1+US2) already delivers full value without history.

**Independent Test**: Run an analysis, edit the profile, re-run the analysis — the old report still shows the original numbers pinned to the old version; the new report reflects the edits and pins the new version.

**Acceptance Scenarios**:

1. **Given** a completed analysis, **When** the user reopens it later, **Then** the stored report is displayed unchanged, with the profile version it was produced from.
2. **Given** a stored analysis, **When** the user re-runs it against the current (edited) profile, **Then** a new report is produced, pinned to the current profile version, and both reports remain in history.
3. **Given** any stored analysis, **When** the user deletes it, **Then** it is removed (parent FR-024 deletion guarantee).

---

### Edge Cases

- **JD too short / no identifiable requirements**: clear message asking for the full JD text; nothing invented.
- **JD with zero hard requirements**: the hard bucket's score weight shifts to the preferred bucket per the clarified formula; the report notes the absence of hard constraints.
- **Profile with no relevant content (or empty profile)**: the report completes honestly with gaps; guidance suggests enriching the profile first.
- **Duplicate or overlapping extracted requirements** (e.g., "Kubernetes" as both skill and tool): user resolves via requirement review; duplicates are flagged for attention, not silently merged.
- **Semantic proposals with dangling evidence**: dropped by the deterministic validator; the drop is counted and surfaced as a validation metric, never as a match.
- **JD language ≠ profile language**: bilingual normalization + alias list apply; requirement text stays in the JD's language; the report is labeled bilingually where useful.
- **Extremely long JD exceeding model input limits**: the user is informed; no silent truncation of requirements.
- **AI failure during extraction**: actionable error per the established taxonomy; the pasted JD text is preserved for retry.
- **AI failure during the semantic step**: the report is still produced from the deterministic exact/alias layers with a visible notice that semantic matching was unavailable — honest partial results, never fabricated semantic matches, never a dead end.
- **User-confirmed semantic match on a hard constraint**: recorded as user-confirmed with the confirmation attributable; it persists across re-runs of the same analysis.
- **Cost**: an analysis run stays under the per-run cost cap; usage is displayed per run (inherited from parent FR-008).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept a pasted job description as plain text with a minimum-length check (default 200 characters, configurable) and a clear error when too short, and MUST detect its language (French or English) deterministically, store it, and allow user correction.
- **FR-002**: System MUST extract structured requirements via the user's AI key — each with requirement text (verbatim from the JD, in the JD's language), category (skill, tool, years of experience, education, domain, language, other), importance (must/nice, recognizing French markers), and a hard-constraint flag — and MUST NOT invent requirements absent from the text.
- **FR-003**: System MUST allow the user to review, correct, remove, and add requirements before finalizing the match; the corrected list is authoritative for matching (parent FR-012).
- **FR-004**: Exact matching MUST be deterministic: normalized (case- and accent-insensitive) comparison of requirement text against profile skills, certifications, and experience/project content.
- **FR-005**: Alias matching MUST use exactly the union of the versioned built-in bilingual global alias list and the user's per-skill approved aliases (parent FR-007); any other synonymy MUST NOT produce an alias match.
- **FR-006**: Semantic matching MUST be LLM-assisted, restricted to non-hard requirements, and evidence-validated: every proposal MUST reference existing profile entry identifiers, and a deterministic validator MUST drop proposals with invalid references before they can appear in the report.
- **FR-007**: Semantic matches MUST NOT satisfy hard constraints; a hard constraint can only be marked met via exact/approved-alias matching or an explicit user confirmation recorded as user-confirmed (parent FR-013).
- **FR-008**: Every requirement MUST receive a status (strong / partial / gap) and match method (exact / approved_alias / semantic / none); matches MUST carry evidence references to concrete profile entries (parent FR-014 canonical RequirementMatch/EvidenceRef shape).
- **FR-009**: The overall score (0–100) MUST be computed deterministically per the parent's clarified formula: hard bucket 60 + preferred bucket 30 + evidence bonus 0–10; per-requirement credit exact 1.0 / approved alias 0.9 / semantic 0.7 / partial 0.5 / gap 0; semantic credit never applies to hard constraints; an empty bucket's weight shifts to the other bucket; the evidence bonus is 10 × (share of matched requirements whose evidence includes an experience or project bullet); the final score is rounded to an integer.
- **FR-010**: The report MUST include recommended keywords and missing keywords derived from the requirement list versus matched evidence (parent FR-014).
- **FR-011**: Every analysis MUST be persisted — JD text, language, finalized requirements, and MatchReport — pinned to the profile version it was produced from; stored reports MUST NOT change silently; re-analysis pins the current version (parent FR-027); analyses are listable and deletable.
- **FR-012**: The MatchReport MUST be copyable as plain text (interview-prep artifact) and offer a per-requirement drill-down showing the evidence entries behind each match.
- **FR-013**: Cross-language matching MUST work in both directions: a JD in one language against a profile in the other produces exact/alias matches via bilingual normalization and the bilingual alias list, without false gaps caused by language alone (parent FR-013/FR-030).
- **FR-014**: AI failures MUST surface actionable errors per the established taxonomy with partial work preserved; semantic-step failure MUST degrade to an exact/alias-only report with a visible notice rather than blocking or fabricating.
- **FR-015**: Analysis runs MUST respect the per-run cost cap and display token/cost usage per run (inherited parent FR-008).

### Key Entities

Canonical schemas live in `ProfileForge-Specification.md` §4; the parent spec's entity descriptions apply. Slice-2 entities conceptually:

- **Job Analysis**: the persisted unit — JD text, detected (or corrected) language, finalized requirement list, MatchReport, pinned profile version, status, timestamps; deletable.
- **Job Requirement**: text (JD language), category, importance (must/nice), hard-constraint flag; user-correctable.
- **Requirement Match**: one requirement's result — status (strong/partial/gap), matchMethod (exact/approved_alias/semantic/none), evidence references, optional note; user-confirmed semantic matches carry their confirmation.
- **Evidence Reference**: typed pointer (bullet / skill / education / certification) with identifier and snippet into a concrete profile entry.
- **Match Report**: per-requirement results, overallScore with deterministic scoreBreakdown (hardRequirementsMet, preferredRequirementsMet, exactMatches, aliasMatches, semanticMatches), recommendedKeywords, missingKeywords, and a semantic-validation metric (dropped invalid proposals).
- **Alias Registry** (read-only input to matching): the versioned built-in bilingual global list plus the profile's per-skill user-approved aliases.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from pasted job description to a complete MatchReport in under 2 minutes including AI processing.
- **SC-002**: On a reviewed sample of job descriptions, at least 85% of clearly stated hard requirements are extracted with the correct importance and hard-constraint flag (target provisional until the Slice-4 benchmark suite exists).
- **SC-003**: 100% of matches in any report carry evidence references that resolve to existing profile entries — zero dangling evidence.
- **SC-004**: Recomputing the score from a stored match set always yields the identical overallScore and breakdown (deterministic core).
- **SC-005**: Semantic proposals with invalid evidence references are dropped 100% of the time and never appear as matches.
- **SC-006**: The report accounts for 100% of finalized requirements — each has a status, method, and evidence-or-gap classification.
- **SC-007**: No hard-constraint gap is ever masked: semantic-only resemblance never marks a hard constraint met without recorded user confirmation.
- **SC-008**: All tested failure paths (too-short JD, invalid key, quota, semantic-step outage) produce either actionable errors with work preserved or an honest degraded report with a visible notice — never fabricated results or dead ends.

## Assumptions

- Parent decisions govern unchanged: score formula, alias governance (hybrid, bilingual built-in list + per-skill approvals), deterministic-first matching, single-user local-first operation, established error taxonomy, and per-run cost cap.
- Minimum JD length defaults to 200 characters (configurable); below that, analysis is refused with guidance.
- Semantic matching in this slice uses LLM proposals validated deterministically — no embedding infrastructure; embeddings are a later-slice option under the same evidence-validation rule.
- The report interface language is English (per parent assumption); requirement text is displayed in the JD's language.
- One analysis per JD paste; every analysis is kept in history until deleted; there is no notion of a "current" analysis overriding stored ones.
- The built-in bilingual alias list ships with a vetted starter set and is versioned with the application; users extend matching only via per-skill approved aliases (re-approval required after list changes affect them).
- User corrections to extracted requirements are stored per analysis and are not fed back into future extractions (no learning loop in this slice).
- Extraction uses the economy model tier; semantic proposals also use the economy tier (two AI calls per analysis typical; both under the per-run cap).
- SC-002's extraction-quality target is provisional and will be enforced by the Slice-4 evaluation benchmark; until then it is verified on a manual sample.
- Out of scope for this slice: CV/cover-letter generation, page budgets, templates/PDF export, interview-prep extensions beyond the copyable report, automated job search.
