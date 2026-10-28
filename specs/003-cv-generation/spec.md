# Feature Specification: ProfileForge Slice 3 — Evidence-Aware CV & Cover Letter Generation (Fact Guard + ATS Export)

**Feature Branch**: `003-cv-generation`

**Created**: 2026-10-22

**Status**: Draft

**Input**: User description: "Slice 3: Evidence-aware CV + cover letter generation with Fact Guard and ATS export. Scope: From a finalized MatchReport, generate a tailored CV and cover letter. Content selection is evidence-aware (relevance + strength + impact + recency); every material claim carries sourceBulletIds / provenance. Fact Guard runs before export: unsupported material claims are blockers that prevent download until resolved or user-confirmed. Single single-column ATS template (standard headings, text-layer PDF, no essential content in headers/footers/images). Automated text-extraction completeness check on every PDF; block and regenerate if it fails. User chooses output language (French or English), independent of source. Omissions list is inspectable and reversible. No automated job search; no multi-template support (deferred)."

**Parent specification**: This slice implements stories and requirements of [specs/001-ats-cv-tailoring/spec.md](../001-ats-cv-tailoring/spec.md) (US5, US6 and FR-015 through FR-025, FR-027, FR-031–FR-033) and the canonical schemas and contracts of `ProfileForge-Specification.md` §4 (`GeneratedCVContent`, `ValidationReport`), §6 (`generateTailoredCV`, `generateCoverLetter`, `factGuard`, `renderCV`), and §7 (ATS optimization & verification), corresponding to Sprint 3 of §11. Where wording differs, the parent spec, the product reference (v0.5), and the decisions recorded in `001/Clarifications (Session 2026-10-21)` govern: the two-level extraction gate, output-language rules, model tiers and cost cap, and the single-template decision are settled and restated here as binding. Slice 2 ([specs/002-jd-matching](../002-jd-matching/spec.md)) supplies the upstream artifact this slice consumes: the finalized, stored job analysis (JD + finalized requirements + MatchReport, pinned to a profile version).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Generate a Tailored, Evidence-Aware CV from a Finalized MatchReport (Priority: P1)

The user selects a completed, finalized job analysis (Slice 2's MatchReport, pinned to a profile version) and requests a tailored CV, choosing settings: output language (French or English, defaulting to the job description's detected language), page budget (default 2 pages, configurable 1–3), and optional free-text notes. Generation runs asynchronously with visible status and can be retried or cancelled. Content selection is evidence-aware: profile entries are ranked by relevance to the job, evidence strength, impact, and recency — no fixed bullet quotas — and the page budget is enforced as a layout constraint after selection, with everything deprioritized recorded as an inspectable omission. Every material claim in the resulting draft carries provenance per the canonical contract: each experience bullet links to its `sourceBulletIds` (with an optional rationale), the summary carries `summaryProvenance` evidence references, and education, projects, and certifications are structured with equivalent evidence links. Where the profile has gaps against the JD, generation uses only truthful content — gaps are never masked with filler. The job operates on the profile snapshot pinned at job start, so later profile edits never mutate an in-flight or completed result.

**Why this priority**: The tailored, provenance-carrying CV is the core deliverable of the product; every other capability exists to make this output trustworthy. Without this story the slice has no deliverable.

**Independent Test**: From a stored finalized analysis, run CV generation and verify: async completion with visible status, every bullet's `sourceBulletIds` resolving to entries in the pinned profile snapshot, omissions listed whenever content exceeded the page budget, and the result recording the profile version it was produced from.

**Acceptance Scenarios**:

1. **Given** a finalized MatchReport and a configured AI key, **When** the user starts CV generation with chosen settings, **Then** the job runs asynchronously with visible status, reaches a clear success or failure state, and can be cancelled or retried.
2. **Given** the generated CV draft, **When** its claims are audited, **Then** every material claim (roles, employers, dates, achievements, skills, metrics) carries provenance — `sourceBulletIds` / evidence references that resolve to entries in the pinned profile snapshot.
3. **Given** tailored content exceeding the selected page budget, **When** generation completes, **Then** the strongest evidence fits the budget and deprioritized items appear in the omissions list with type, identifier, and reason.
4. **Given** a profile with major gaps against the job description, **When** the CV is generated, **Then** it contains only truthful, profile-backed content — gaps are not masked by fabricated or padded claims.
5. **Given** a profile edited while a generation job is in flight, **When** the job completes, **Then** the result reflects only the profile snapshot pinned at job start and records that version.
6. **Given** a completed generation, **When** the user changes settings (notes, page budget, output language) and regenerates, **Then** a new version is produced without re-entering the profile or job description, and prior versions are kept.
7. **Given** a profile with little or no work experience (recent graduate), **When** the CV is generated, **Then** it is built truthfully from education, projects, and skills.

---

### User Story 2 — Fact Guard: No Download Until Every Material Claim Is Backed or Confirmed (Priority: P1)

Before any export, a claim-level Fact Guard validates the draft against the pinned profile. Deterministic checks run first — every provenance reference resolves to an existing profile entry, and every number, date, duration, and metric is identical to its cited evidence under normalized comparison — followed by an LLM-assisted semantic fidelity check that rephrased claims preserve the meaning of their evidence. Unsupported material claims are raised as **blockers** with machine-readable codes, severity (blocker/warning), affected fields, supporting evidence, and resolution state; warnings inform but never block. While any blocker is unresolved, download is prevented. The user resolves blockers by editing the claim, removing it, or explicitly confirming it — confirmation is recorded and attributable. Any edit triggers re-validation. If the Fact Guard's AI layer cannot run, export stays blocked (fail-closed) while deterministic checks still surface. For cross-language outputs, the Fact Guard validates the translated claim against source-language profile evidence.

**Why this priority**: Zero invented facts is the product's non-negotiable first principle, and this is where it is enforced. The gate is what makes every download trustworthy.

**Independent Test**: Generate a draft containing a deliberately unsupported metric; verify it is flagged as a blocker and download is unavailable; edit the claim, confirm re-validation clears the flag, and download becomes available.

**Acceptance Scenarios**:

1. **Given** a draft containing a claim with no supporting profile evidence, **When** the Fact Guard runs, **Then** the claim is flagged as a blocker with a machine-readable code, affected field, and pending resolution, and download is prevented.
2. **Given** an unresolved blocker, **When** the user edits or removes the claim, **Then** the document is re-validated, the flag's resolution state updates (edited / removed), and download unlocks only when no blockers remain.
3. **Given** an unresolved blocker, **When** the user explicitly confirms the claim as accurate, **Then** the confirmation is recorded and attributable, the flag becomes user_confirmed, and download unlocks.
4. **Given** claims whose numbers, dates, durations, or metrics differ from their cited evidence, **When** validation runs, **Then** they are flagged by the deterministic layer — this holds even when the AI layer is unavailable.
5. **Given** an AI failure in the Fact Guard's semantic layer, **When** the user attempts to export, **Then** the export is blocked with a clear, actionable error (fail-closed), deterministic-check results are still surfaced, and no ungated download occurs.
6. **Given** a translated (cross-language) draft, **When** the Fact Guard validates, **Then** claims are checked against the source-language profile evidence, and every number, date, duration, and metric must be identical.

---

### User Story 3 — Verified ATS Export: Single-Column PDF That Actually Parses (Priority: P1)

Blocker-free content renders through the single MVP template — single column, standard section headings in the output language (Professional Summary, Experience, Education, Skills, optional Projects / Certifications / Languages — or their standard French equivalents), consistent normalized dates, and no essential content in headers, footers, or images — into a PDF with a real text layer. The Skills section surfaces exact and approved-alias matches using the job description's terminology where the profile supports them. Every PDF must pass the two-level automated extraction-completeness gate before download is offered: (1) 100% of structural elements — name, contact items, all standard section headings, every experience entry's company/title/dates — recoverable from the PDF text layer; (2) every content block (bullet, summary, education entry) at ≥95% word-level recovery under normalized (case-, accent-, whitespace-, and punctuation-insensitive) comparison, with identical rules for French and English. A failing export is blocked and regenerated within bounded retries, then fails visibly; a failing document is never offered for download. A best-effort DOCX convenience export is available without the gate — the verified deliverable is the PDF.

**Why this priority**: ATS compatibility is only real if it is verified by text extraction, not assumed from template rules (guiding principle 2). An unverifiable export would break the product's core promise.

**Independent Test**: Generate and export a CV; extract the delivered PDF's text and confirm all structural elements are recoverable and every content block reaches ≥95% word-level recovery; introduce a rendering defect and confirm the gate blocks the download and triggers regeneration.

**Acceptance Scenarios**:

1. **Given** a completed, blocker-free document, **When** it is rendered and passes the two-level extraction gate, **Then** download of the PDF is offered.
2. **Given** a rendered PDF that fails either gate level, **When** the check runs, **Then** the export is blocked, regeneration is attempted within bounded retries, and the failing document is never offered for download; exhausted retries land in a visible failed state with the check results.
3. **Given** French output with accented text, **When** the extraction check runs, **Then** accent- and case-insensitive normalization ensures legitimate French accents never fail the gate while genuinely missing content still does.
4. **Given** a generated CV, **When** rendered, **Then** it is single-column with standard headings in the output language, consistent normalized dates, no essential content in headers/footers/images, and names with diacritics render correctly.
5. **Given** exact or approved-alias matches between the profile and the JD, **When** the Skills section is composed, **Then** matched skills are surfaced using the job description's terminology where supported.
6. **Given** a verified PDF download, **When** the user also wants a DOCX, **Then** a best-effort DOCX is available without the extraction gate (the PDF remains the verified deliverable).

---

### User Story 4 — Choose the Output Language, Independent of the Source (Priority: P2)

For each generation the user chooses French or English as the output language, regardless of the profile's or job description's language; when no choice is made, output defaults to the job description's detected language. All generated narrative text (summary, bullets, cover letter body) and section headings are produced in the selected language. Proper nouns — employer, institution, and certification names — are preserved verbatim; degrees and credentials use faithful official equivalents only, with anything uncertain flagged for user confirmation rather than improvised. Every number, date, duration, and metric is identical to the profile; translation is treated as rephrasing under the Fact Guard.

**Why this priority**: Bilingual output is a first-class product requirement, but it is a setting on the generation flow with a safe default (the JD's language), so the core flow delivers value without it.

**Independent Test**: Generate from a French profile against an English JD with output language French (and the reverse); verify fully output-language text, verbatim proper nouns, identical numbers/dates/metrics, and Fact Guard validation against source-language evidence.

**Acceptance Scenarios**:

1. **Given** a profile in one language and the output language set to the other, **When** the CV or cover letter is generated, **Then** all narrative text and section headings are in the output language.
2. **Given** proper nouns in the profile, **When** generation runs in the other language, **Then** employer, institution, and certification names are preserved verbatim.
3. **Given** metrics and dates in the profile, **When** translated output is produced, **Then** every number, date, duration, and metric is identical to the profile.
4. **Given** no explicit output-language choice, **When** generation starts, **Then** the output language defaults to the job description's detected language.

---

### User Story 5 — Inspect and Reverse Omissions (Priority: P2)

Whenever the page budget forces deprioritization, the omitted items are listed with type, identifier, and reason. The user inspects the list and can restore any omitted item; restored items are treated as must-include for the next regeneration, and if a restored item still cannot fit the budget, the system says so explicitly instead of silently omitting it again.

**Why this priority**: Transparent, reversible omissions turn truncation from silent data loss into a user-controlled decision. It refines US1 rather than gating it.

**Independent Test**: Generate with a tight page budget producing omissions, restore one item, regenerate, and verify the restored item appears in the new version.

**Acceptance Scenarios**:

1. **Given** a generation that deprioritized content, **When** the user views the omissions list, **Then** each entry shows type, identifier, and reason.
2. **Given** an omitted item, **When** the user restores it and regenerates, **Then** the new version includes the item.
3. **Given** a restored item that cannot fit within the page budget, **When** regeneration runs, **Then** the system reports the conflict explicitly (guiding the user to raise the budget or trim content) instead of silently re-omitting.
4. **Given** a generation where everything fit, **When** the user checks, **Then** the omissions list is present and empty — no hidden truncation.

---

### User Story 6 — Generate a Complementary Cover Letter (Priority: P2)

From the same finalized analysis, the user generates a cover letter with a chosen tone (default: professional) and the output language honored. The letter adds context and motivation connected to the job's requirements without repeating the CV — no verbatim reuse of CV bullets — and the same zero-invention rule and claim-level Fact Guard apply, with its factual statements carrying evidence references. It is delivered as a text-layer PDF passing the same extraction gate and as copyable plain text for online application forms, fitting one page by default.

**Why this priority**: The letter completes the application package by reusing the entire existing pipeline (profile, analysis, Fact Guard, rendering) — high value for modest additional scope, but not required for the core CV flow.

**Independent Test**: Request a cover letter with a chosen tone after a finalized analysis; verify it does not duplicate CV bullets, its claims are traceable, its PDF passed the extraction gate, and it can be copied as plain text.

**Acceptance Scenarios**:

1. **Given** a finalized analysis, **When** the user generates a cover letter with a chosen tone and output language, **Then** the letter is written in that language and tone, adds context and motivation, and contains no verbatim reuse of CV bullets.
2. **Given** the generated letter, **When** its claims are audited, **Then** no achievements, metrics, or experience are fabricated, factual statements carry evidence references, and blockers gate download exactly as for the CV.
3. **Given** a completed letter, **When** the user wants to use it, **Then** it downloads as a text-layer PDF that passed the same extraction gate and can be copied as plain text.

---

### Edge Cases

- **Generation cannot fit the page budget even after trimming** (very extensive profile, minimal budget): the user is told explicitly and guided to increase the budget or trim the profile; no silent overflow.
- **Rendered PDF fails the extraction-completeness check**: the export is blocked, regeneration is attempted within bounded retries (default 3), then the job lands in a visible failed state with the check results; the failing artifact is never downloadable.
- **Fact Guard cannot complete** (AI failure in the semantic layer): fail-closed — export is blocked with an actionable error; the deterministic layer (reference resolution, numeric identity) still runs and surfaces its findings; no ungated download.
- **Generation model failure mid-job** (invalid key, exhausted quota, rate limit, service outage): the job lands in a visible failed state with the established taxonomy error; completed work (analysis, prior versions) is preserved; retry is available; nothing fabricated is substituted.
- **Per-run cost cap reached mid-generation**: hard stop with a clear message and token/cost usage displayed; partial work preserved.
- **Profile edited while a job is in flight**: the job continues on its pinned snapshot; the completed result records the job-start profile version; the next generation picks up the new version.
- **User-confirmed blockers across regeneration**: confirmations attach to specific claims; on regeneration, claims whose text and evidence are unchanged keep their confirmation, and changed claims are re-validated fresh.
- **Overlapping or conflicting employment dates in the profile**: the user is warned and must resolve the conflict before generation starts.
- **Profile with little or no work experience** (recent graduate): generation succeeds using education, projects, and skills.
- **Empty profile sections**: optional headings (Projects, Certifications, Languages) are simply not rendered — no empty sections in the output.
- **Untranslatable proper nouns and credentials**: preserved verbatim or translated only via faithful official equivalents; anything uncertain is flagged for user confirmation, never improvised.
- **Names with diacritics and special characters**: preserved correctly through generation and the extraction gate (accent-insensitive normalization prevents false gate failures).
- **JD terminology unsupported by the profile**: the Skills section never presents unsupported keywords as skills — missing keywords stay in the Match Report, not in fabricated CV content.
- **Whole-entry drops for very large profiles** (e.g., oldest roles cut entirely): recorded as omissions with a page-budget reason, inspectable and reversible like any other.
- **Tone setting produces exaggerated claims**: the Fact Guard flags inflated or unsupported statements as blockers regardless of tone.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow the user to initiate CV and cover-letter generation only from a finalized, stored job analysis (Slice 2 MatchReport), with settings: output language (French/English), page budget (1–3 pages, default 2), tone (cover letter), and free-text notes; generation MUST run asynchronously with visible status, clear success/failure states, retries, and cancellation (parent FR-015, FR-024).
- **FR-002**: Every generation job MUST operate on the profile snapshot pinned at job start, and every produced document MUST record the profile version and originating analysis it was produced from; later profile edits MUST NOT mutate in-flight or stored results (parent FR-027).
- **FR-003**: Content selection MUST be evidence-aware — ranking profile entries by relevance to the job, evidence strength, impact, and recency — without fixed bullet quotas; the page budget MUST be enforced as a layout constraint after selection (parent FR-016).
- **FR-004**: Every material claim in generated content MUST carry provenance per the canonical `GeneratedCVContent` contract: experience bullets with non-empty `sourceBulletIds` resolving to pinned-profile entries (plus optional rationale), the summary with `summaryProvenance`, and education, projects, certifications, and cover-letter statements structured with equivalent evidence references.
- **FR-005**: All content deprioritized by the page budget MUST be recorded as omissions `{type, id, reason}`; the omissions list MUST be inspectable; restoring an item MUST mark it must-include for the next regeneration; a restored item that still cannot fit MUST produce an explicit conflict message rather than a silent re-omission (parent FR-017).
- **FR-006**: Generation MUST NOT mask gaps: content is limited to truthful, profile-backed material; unmet requirements never produce fabricated claims; JD keywords without profile support MUST NOT be presented as skills.
- **FR-007**: A claim-level Fact Guard MUST validate every generated document against the pinned profile before export, producing the canonical `ValidationReport`: flags with machine-readable code, claim text, severity (blocker/warning), affected field identifiers, supporting evidence, and resolution state (pending / user_confirmed / edited / removed) (parent FR-018).
- **FR-008**: The Fact Guard MUST run two layers: deterministic checks — provenance references resolve to existing profile entries, and every number, date, duration, and metric is identical to its cited evidence under normalized comparison — executable without AI; then an LLM-assisted semantic fidelity check that rephrased claims preserve the meaning of their evidence.
- **FR-009**: Unsupported material claims MUST be blockers that prevent download until resolved (edited/removed) or explicitly user-confirmed; confirmations MUST be recorded and attributable; warnings MUST inform without blocking; any user edit to a claim MUST trigger re-validation of the document.
- **FR-010**: The Fact Guard MUST fail closed: if validation cannot complete, export MUST be blocked with an actionable error while deterministic-check results are still surfaced; no document may be downloaded unvalidated.
- **FR-011**: The MVP MUST render through exactly one single-column ATS template with standard section headings in the output language (English: Professional Summary, Experience, Education, Skills, optional Projects, Certifications, Languages; French: "Résumé professionnel", "Expérience professionnelle", "Formation", "Compétences", and standard equivalents), consistent normalized dates, and no essential content in headers/footers or images; optional sections MUST NOT render empty; additional templates are deferred post-MVP (parent FR-019/020).
- **FR-012**: The Skills section MUST surface exact and approved-alias matched skills using the job description's terminology where the profile supports them (parent FR-020).
- **FR-013**: Every generated PDF MUST pass the two-level extraction-completeness gate before download is offered — (1) 100% of structural elements (name, contact items, all standard section headings, every experience entry's company/title/dates) recoverable from the PDF text layer; (2) every content block (bullet, summary, education entry) at ≥95% word-level recovery under normalized (case-, accent-, whitespace-, and punctuation-insensitive) comparison, identical rules for French and English. Failing exports MUST be blocked and regenerated within bounded retries (default 3), then fail visibly with the check results; a failing document MUST NEVER be offered for download (parent FR-021).
- **FR-014**: DOCX export MUST be available as a best-effort convenience output without the extraction gate; the verified deliverable is the PDF (decided exception, parent FR-021).
- **FR-015**: The output language MUST be selectable (French or English) per generation, independent of the profile's and JD's languages, defaulting to the job description's detected language when no choice is made; all narrative text and headings MUST be in the output language; proper nouns MUST be preserved verbatim; degrees and credentials MUST be translated only via faithful official equivalents, with uncertain items flagged for user confirmation; every number, date, duration, and metric MUST be identical to the profile; the Fact Guard MUST validate translated claims against source-language evidence (parent FR-031–FR-033).
- **FR-016**: The cover letter MUST complement the CV (no verbatim reuse of CV bullets), MUST accept a tone setting (default: professional), MUST honor the output language, MUST be subject to the same zero-invention rule and claim-level Fact Guard with evidence-referenced statements, and MUST fit one page by default (parent FR-022).
- **FR-017**: The cover letter MUST be downloadable as a text-layer PDF passing the same extraction gate and copyable as plain text for pasting into application forms (parent FR-023).
- **FR-018**: Regeneration with changed settings (tone, notes, page budget, output language) MUST NOT require re-entry of the profile or job description; generated document versions MUST be kept, and each version's Fact Guard report and extraction-check results MUST be stored with it (parent FR-024).
- **FR-019**: Generation tasks MUST use the premium model tier (`generateTailoredCV`, `generateCoverLetter`) and validation the economy tier (`factGuard`), under the per-application-run cost cap (default $0.50, hard stop, user-adjustable); token/cost usage MUST be displayed per run (parent FR-008).
- **FR-020**: AI failures MUST surface specific, actionable errors per the established taxonomy, MUST preserve all work completed up to the failed step, and MUST NOT substitute fabricated content for failed AI output (parent FR-025).

### Key Entities

Canonical schemas live in `ProfileForge-Specification.md` §4 (authoritative); the parent spec's entity descriptions apply. Slice-3 entities conceptually:

- **Generation Job**: the async unit of work — target document kind (CV / cover letter), originating job-analysis reference, settings (output language, page budget, tone, notes), pinned profile version, lifecycle states (queued, running, succeeded, failed, cancelled), retry/cancel controls, and per-run token/cost usage.
- **Generated Document (version)**: structured content in the output language (`GeneratedCVContent` for the CV; a structured letter whose statements carry evidence references for the cover letter), the omissions list, the Fact Guard report, settings, pinned profile version, render artifacts (PDF / DOCX / plain text) with their extraction-check results, and downloadable state.
- **Material Claim**: an atomic factual statement in generated content carrying provenance (`sourceBulletIds` / evidence references); the unit of Fact Guard validation and of user resolution (edit / remove / confirm).
- **Fact Guard Validation Report**: canonical flags — code, claim, severity (blocker/warning), affected field identifiers, supporting evidence, resolution state — produced per document version.
- **Omission**: `{type, id, reason}` plus restore state (omitted / restored-must-include); reversible through regeneration.
- **Template**: the single single-column ATS rendering definition with standard headings per output language; no alternative templates in MVP.
- **Extraction Check Result**: the per-artifact outcome of the two-level gate — structural-element recovery and per-block word-level recovery — stored with the document version.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a finalized MatchReport to a reviewable CV draft — claims, provenance, and omissions visible — in under 3 minutes including AI processing, for typical profiles.
- **SC-002**: 100% of material claims across generated CVs and cover letters trace to pinned-profile evidence or a recorded user confirmation — zero fabricated experience or metrics — and all known unsupported claims in the benchmark are flagged as blockers.
- **SC-003**: 100% of PDFs offered for download pass the two-level extraction gate (all structural elements recoverable; every content block at ≥95% word-level recovery); zero failing PDFs are ever downloadable.
- **SC-004**: For typical profiles, at least 90% of first-time CV generations fit the selected page budget without manual iteration; in all cases omissions are inspectable and restorable.
- **SC-005**: Cross-language generations (FR→EN and EN→FR) produce documents fully in the output language, with 100% of proper nouns preserved verbatim and 100% numeric/date/metric identity with the profile.
- **SC-006**: Restored omissions appear in the next generated version 100% of the time when the page budget allows; when it does not, an explicit conflict is surfaced — never a silent re-omission.
- **SC-007**: All tested failure paths (generation-model failure mid-job, cost-cap stop, Fact Guard unavailability, extraction-gate failure) end in visible, actionable states with prior work preserved — no dead ends and no ungated downloads.
- **SC-008**: Generated cover letters contain no verbatim reuse of CV bullets (verified by automated overlap check on benchmark cases) and their claims pass the same Fact Guard gate as the CV.

## Assumptions

- Parent decisions govern unchanged: single-template MVP, page budget as layout constraint (default 2 pages, 1–3), the two-level extraction gate and its thresholds, output-language rules and default, model tiers and per-run cost cap, established AI error taxonomy, single-user local-first operation, and an English interface language.
- A "finalized MatchReport" is a completed, stored Slice 2 analysis; generation cannot start from an unsaved or in-progress analysis.
- CV and cover letter are requested as separate generation jobs within the same application context; each maintains its own version chain.
- The cover letter defaults to one page and a professional tone; additional tones are generation settings, not separate templates.
- Optional CV sections (Projects, Certifications, Languages) render only when selected content exists.
- The Fact Guard is layered (deterministic checks + LLM semantic fidelity); the deterministic layer alone can flag reference-resolution and numeric-identity violations, so AI unavailability degrades but never disables validation.
- Fact Guard confirmations attach to specific claims and persist across regeneration only for claims whose text and evidence are unchanged; changed claims are re-validated fresh.
- Bounded extraction-gate regeneration retries default to 3 before a visible failure.
- Direct free-form editing of the rendered PDF is out of scope: claim-level resolution (edit / remove / confirm) happens on the structured content, and broader refinement happens through profile edits, omission restores, and regeneration settings (inherited parent assumption).
- Rendered-document live preview and the Gap Bridge belong to Slice 4 (benchmark & polish); this slice provides structured content review with claim drill-down, gated downloads, and omission management.
- Automated benchmark-scale verification of SC-002, SC-004, SC-005, and SC-008 lands with the Slice 4 evaluation suite; until then they are verified on an inline fixture set (mirroring Slice 2's provisional-target approach).
- Out of scope for this slice: automated job search, job board integrations, additional templates / multi-template selection, DOCX extraction gating, interview-prep extensions beyond the existing copyable report, and multi-user hosting.
