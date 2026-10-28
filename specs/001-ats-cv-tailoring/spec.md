# Feature Specification: ProfileForge — ATS-Optimized CV & Cover Letter Tailoring (MVP, Bilingual FR/EN)

**Feature Branch**: `001-ats-cv-tailoring`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Build ProfileForge, a web application that helps users create highly ATS-optimized, interview-maximizing CVs and cover letters. User flow: 1. User uploads an existing CV (PDF/DOCX). System parses it into a structured profile (experience, education, skills, languages, etc.) with provenance. 2. User can manually enrich the profile with additional experience, qualifications, projects, and languages. 3. User pastes a job description. 4. System uses the user's OpenRouter API key to: extract requirements from the JD; match against the profile (exact + semantic); generate a tailored CV from one of several ATS-friendly templates; generate a matching cover letter. 5. User can download the CV as a clean, text-layer PDF. Key constraints: strict fact-guarding (never invent experience or metrics); ATS-friendly output (single column, standard headings, no graphics that break parsers); match report that shows evidence and gaps (usable for interview prep); page-budget awareness during generation; multi-template support. MVP scope only — no automated job searching yet."

**Amendment 2026-10-21 (bilingual support)**: "Add bilingual (French / English) support as a first-class requirement: users may upload CVs in French or English; the system detects the source language and stores profile content with language metadata; at generation time the user chooses the output language (French or English), independent of the source language; all generated text (summary, bullets, cover letter) is produced in the selected output language; fact-guarding still applies — no invented facts, only rephrasing/translation of existing profile content; ATS rules remain identical for both languages (standard headings, text-layer PDF); date normalization and skill/alias matching must work for both languages."

**Authoritative reference**: Where this description conflicts with `ProfileForge-Specification.md` (v0.5), the reference document governs. Notable resolutions: multiple CV templates are **deferred post-MVP** (one reliable single-column template in MVP), matching follows the deterministic exact / approved-alias / semantic contract with a reproducible score breakdown, and model selection is configurable.

## Clarifications

### Session 2026-10-21

- Q: What concrete scoring formula should the Match Report use for its 0–100 overall score? → A: Weighted formula — hard 60 + preferred 30 + evidence bonus 0–10; credit exact 1.0 / approved alias 0.9 / semantic 0.7 / partial 0.5 / gap 0; semantic never counts toward hard; bonus = 10 × share of matches backed by experience/project bullets; empty bucket's weight shifts to the other bucket.
- Q: Who approves skill aliases, where are they stored, and are they global or per-profile? → A: Hybrid — a versioned built-in global list of vetted common tech aliases ships with the app, plus user-approved aliases stored per Skill entry in the profile; matching uses the union of both, and nothing else counts as an alias.
- Q: What extraction-completeness threshold should block PDF export, and how is it measured? → A: Two-level gate — 100% of structural elements (name, contact items, standard section headings, every experience entry's company/title/dates) must be recoverable from the PDF text layer, AND each content block (bullet, summary, education entry) must reach ≥95% word-level recovery under normalized (case/whitespace/punctuation-insensitive) comparison against source content; failing either blocks export.
- Q: Should DOCX export be included in the MVP or deferred to post-MVP? → A: Included in MVP as a best-effort convenience output without the extraction-completeness gate; the verified, gated deliverable is the PDF.
- Q: What default OpenRouter models and cost limits should apply to the AI tasks (parse, extract, generate)? → A: Two-tier configurable defaults — economy-class model (Flash/Mini-class) for parseCV, extractRequirements, factGuard; premium-class model (Sonnet-class) for generateTailoredCV, generateCoverLetter; per-application-run cost cap of $0.50 by default (hard stop, user-adjustable); token/cost usage displayed per run.
- Decision (scan, Sprint 1 blocker): Profile-version pinning — every Match Report and generated document records the profile version it was produced from, and generation jobs operate on the profile snapshot taken at job start; later profile edits never mutate in-flight or past results.
- Decision (scan, Sprint 1 blocker): Very long CVs — CVs up to ~10 pages parse fully; beyond that (or beyond the model's usable input), the system warns the user and requires explicit confirmation before partial parsing — never silent truncation.
- Decision (scan, Sprint 1 blocker): Blank/failed parse — if an uploaded file has a text layer but extraction yields no meaningful content, the system creates an empty profile with a low-confidence flag and directs the user to manual enrichment.
- Decision (scan, Sprint 1 blocker): Duplicate entries — adding a skill or other entry that exactly duplicates an existing one prompts merge-or-keep, preventing duplicates from skewing matching.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Upload and Parse an Existing CV into a Structured Profile (Priority: P1)

A job seeker uploads their current CV as a PDF or DOCX file. The system parses it into a structured profile — basics (name, headline, summary, location, contact, links), work experience, education, skills, languages, certifications, and projects — with all dates normalized (YYYY-MM, or "present"). Every parsed entry records provenance (source document and approximate location), and low-confidence fields are flagged for the user's attention. The CV's source language (French or English) is detected on upload, stored as profile metadata, and shown to the user for correction. The profile is presented for review.

**Why this priority**: The structured profile is the single source of truth for the entire product; no other feature works without it. It also delivers standalone value: an organized, verifiable digital profile with normalized dates and confidence flags.

**Independent Test**: Can be fully tested by uploading a sample text-based CV and confirming the parsed profile appears with all major sections populated, dates normalized, provenance visible, and low-confidence fields flagged — no job description or AI key required.

**Acceptance Scenarios**:

1. **Given** a text-based PDF or DOCX CV in French or English, **When** the user uploads it, **Then** the system extracts the structured profile (basics, experience, education, skills, languages, certifications, projects) with every entry carrying source provenance, and records the detected source language as profile metadata.
2. **Given** any parsed date in English or French format (e.g., "Jan 2023", "01/2023", "janv. 2023", "sept. 2021 – aujourd'hui", "depuis 2020"), **When** parsing completes, **Then** dates are normalized to YYYY-MM (or "present") throughout the profile.
3. **Given** fields the parser is unsure about, **When** the profile is presented, **Then** those fields are visibly flagged as low-confidence for user review.
4. **Given** a scanned/image-only PDF with no extractable text, **When** the user uploads it, **Then** the system clearly states that no text could be extracted and guides the user to provide a text-based file (no silently corrupted profile).
5. **Given** an unsupported format or a file above the size limit, **When** the user uploads it, **Then** the system rejects it with a clear message stating which formats and sizes are accepted.
6. **Given** a CV whose detected language is wrong (e.g., a French CV misdetected as English), **When** the user corrects the language in the profile, **Then** the stored language metadata updates and downstream processing (date normalization, heading recognition) uses the corrected language.

---

### User Story 2 — Review, Correct, and Enrich the Profile (Priority: P2)

The user reviews the parsed profile, resolves flagged low-confidence fields, corrects mis-parsed items, and enriches the profile with additional experience, qualifications, projects, and languages that were not in the uploaded CV. The editor offers full create/read/update/delete with provenance tracking and autosave. Skill levels are only ever user-stated, never inferred from keyword presence.

**Why this priority**: Automated parsing is never perfect, and richer profiles produce better matches and stronger tailored documents. However, the core downstream flow already works with the parsed profile alone, so this is a quality multiplier rather than a gate.

**Independent Test**: Can be fully tested by opening the profile editor, resolving a flagged field, correcting a mis-parsed date, adding a new certification and language, and confirming the changes are saved (autosave) and reflected in the stored profile with updated provenance.

**Acceptance Scenarios**:

1. **Given** a parsed profile, **When** the user edits or deletes any entry, **Then** the change is saved automatically and the entry's provenance is updated to reflect the user's action.
2. **Given** the profile editor, **When** the user adds a new experience entry, qualification, project, language, or skill, **Then** it is stored as a user-entered fact and included in future matching and generation.
3. **Given** a skill, **When** the user states a proficiency level or approves an alias (e.g., "K8s" for "Kubernetes"), **Then** that information is recorded as user-provided — levels and aliases are never inferred by the system on their own.

---

### User Story 3 — Configure Your Own AI Provider Key and Model (Priority: P2)

The user provides their own OpenRouter API key — via an in-app setting or an environment variable for the single-user prototype — and may configure which model(s) are used. The system validates the key before use, keeps it secret (never displayed in full when stored in-app, never written to logs, exports, or generated documents), and routes every AI task through it, sending only the minimal profile and job-description text each task needs.

**Why this priority**: Bring-your-own-key is an explicit product decision (AI cost stays with the user), and it enables all AI features (parsing assistance, requirement extraction, semantic matching, generation). It is a small, self-contained slice that can be built and demonstrated on its own.

**Independent Test**: Can be fully tested by configuring a valid key (validation succeeds), then an invalid key (validation fails with a clear message), and by observing that a configured model choice is respected on the next AI call.

**Acceptance Scenarios**:

1. **Given** the key configuration, **When** the user provides a valid key, **Then** the system confirms it works and uses it for all AI tasks.
2. **Given** the key configuration, **When** the user provides an invalid or expired key, **Then** the system reports the problem clearly without proceeding.
3. **Given** a stored key, **When** the key would be displayed, logged, or included in an export or generated document, **Then** it is not (masked at most; secret preserved).
4. **Given** configurable model selection, **When** the user chooses a model, **Then** subsequent AI tasks use that model.

---

### User Story 4 — Analyze a Job Description and Get a Deterministic Match Report (Priority: P1)

The user pastes a job description. The system extracts its requirements (text, category, importance as must-have vs. nice-to-have, and whether each is a hard constraint such as a required tool, certification, license, or explicit years of experience). Matching then follows a deterministic, reproducible contract: exact matches first, then approved-alias matches, then semantic (meaning-based) matches — with semantic matches never satisfying hard constraints unless the user explicitly confirms them. The resulting Match Report shows, for every requirement, a status (strong / partial / gap), the match method, and evidence references pointing to specific profile entries, plus an overall 0–100 score with a reproducible breakdown, recommended keywords, and missing keywords. The report doubles as interview-prep material.

**Why this priority**: The match report is the decision-making heart of the product: it tells the user honestly how well they fit, provides the evidence base for tailoring, and is a reproducible, auditable artifact rather than an opaque AI opinion.

**Independent Test**: Can be fully tested by pasting a job description with known requirements against a known profile and verifying statuses, match methods, evidence references, and that the score is identical across repeated runs on identical inputs.

**Acceptance Scenarios**:

1. **Given** a stored profile, a configured AI key, and a pasted job description in French or English, **When** the user runs the analysis, **Then** every extracted requirement is displayed with its category, importance (must/nice), and hard-constraint flag, with must/nice classification understood in both languages (e.g., "exigé/obligatoire" vs. "atout/un plus").
2. **Given** the extracted requirements, **When** the user believes an item was extracted incorrectly, **Then** they can correct or remove it before finalizing the match.
3. **Given** the analysis results, **When** the user views the Match Report, **Then** each requirement shows status (strong/partial/gap), match method (exact / approved alias / semantic / none), and evidence references to specific profile entries.
4. **Given** a hard constraint with no exact or approved-alias match, **When** the report is produced, **Then** it remains a gap — a semantic resemblance alone does not satisfy it unless the user explicitly confirms.
5. **Given** identical profile and job description inputs, **When** the analysis is repeated, **Then** the overall score and its breakdown are reproducible (deterministic scoring).
6. **Given** the Match Report, **When** requirements are unmet, **Then** gaps and missing keywords are listed clearly rather than hidden, and recommended keywords are surfaced.
7. **Given** an invalid key, exhausted quota, or unavailable AI service, **When** the user runs the analysis, **Then** the system shows a clear, actionable error and does not present partial or fabricated results.
8. **Given** a job description in one language and a profile in the other (e.g., English JD, French profile), **When** matching runs, **Then** exact and approved-alias matching still apply via bilingual normalization and the bilingual alias list, so the language difference alone does not create a false gap.

---

### User Story 5 — Generate and Download a Tailored, ATS-Friendly CV (Priority: P1)

The user requests a tailored CV for the analyzed job, choosing the output language (French or English) — a choice independent of the profile's source language. Generation runs asynchronously with visible status. Content selection is evidence-aware — ranking by relevance to the job, evidence strength, impact, and recency, with no fixed bullet quotas — and the page budget is enforced as a layout constraint after selection: whatever doesn't fit is recorded as an inspectable, reversible omission rather than silently dropped or allowed to overflow. Every material claim in the output must link to profile evidence; a claim-level Fact Guard validates the draft, and unresolved blocking flags prevent download until resolved or explicitly user-confirmed by the user. The CV renders through the single MVP template (single column, standard headings) into a PDF with a real text layer, and every export must pass an automated text-extraction completeness check before download is offered.

**Why this priority**: The tailored, verified, ATS-friendly CV is the core deliverable of the product — everything else exists to make this output trustworthy and effective.

**Independent Test**: Can be fully tested by generating a CV from a stored profile and completed job analysis and verifying: async completion, claim-to-evidence traceability, omission listing, page-budget fit, and a downloadable PDF that passes text extraction.

**Acceptance Scenarios**:

1. **Given** a stored profile and a completed job analysis, **When** the user starts generation, **Then** the job runs asynchronously with visible progress and completes in a clear success or failure state.
2. **Given** the generated CV, **When** its material claims are audited, **Then** every claim (roles, employers, dates, achievements, skills, metrics) links to supporting profile evidence — nothing is invented.
3. **Given** a claim that cannot be linked to evidence, **When** the Fact Guard validates the draft, **Then** it is flagged with severity; blocking flags prevent download until the claim is resolved (edited, removed) or explicitly confirmed by the user.
4. **Given** the page budget, **When** tailored content exceeds it, **Then** the system deprioritizes content to fit and records what was omitted, with reasons, in an inspectable list the user can restore from.
5. **Given** a completed generation, **When** the user downloads the CV, **Then** the PDF has a real text layer (selectable/searchable content), a single-column layout with standard section headings in the output language (Professional Summary, Experience, Education, Skills, optional Projects — or their standard French equivalents), and normalized dates throughout.
6. **Given** a generated PDF, **When** the system runs its automated text-extraction check (name, contact, section headings, experience entries present; no critical data loss), **Then** the download is offered only if the check passes — otherwise the export fails visibly and is regenerated.
7. **Given** a profile with major gaps against the job description, **When** the user generates a CV, **Then** generation succeeds using only truthful content — gaps are not masked by semantic matches or fabricated filler.
8. **Given** a completed generation, **When** the user changes settings (e.g., notes, page budget, output language) and regenerates, **Then** the system produces a new version without requiring the profile or job description to be re-entered.
9. **Given** a profile in one language and a selected output language in the other, **When** the CV is generated, **Then** all generated narrative text (summary, bullets) and headings are in the output language, proper nouns (employer, institution, and certification names) are preserved as-is, and every number, date, and metric is identical to the profile — the Fact Guard validates translated claims against the source-language evidence.

---

### User Story 6 — Generate a Complementary Cover Letter (Priority: P2)

The user generates a cover letter from the same profile, Match Report, and a chosen tone. The letter adds context and motivation — it must not repeat the CV. It follows the same zero-invention rule and passes the same claim-level Fact Guard, and it is available as a text-layer PDF and as copyable plain text for pasting into online application forms.

**Why this priority**: The cover letter completes the application package and reuses the entire existing pipeline (profile, analysis, fact guard, rendering), adding high value for modest additional scope. It is not required for the core CV flow to be valuable.

**Independent Test**: Can be fully tested by requesting a cover letter after a job analysis with a chosen tone and verifying: it does not duplicate CV content, its claims are traceable to the profile, and it is downloadable as PDF and copyable as plain text.

**Acceptance Scenarios**:

1. **Given** a stored profile and a completed job analysis, **When** the user generates a cover letter with a chosen tone and output language, **Then** the letter is written in the selected output language and adds context and motivation connected to the job's requirements without repeating the CV's content.
2. **Given** any generated cover letter, **When** its claims are audited, **Then** no achievements, metrics, or experience are fabricated — the same Fact Guard rules apply.
3. **Given** a completed cover letter, **When** the user wants to use it, **Then** it can be downloaded as a text-layer PDF and copied as plain text.

---

### Edge Cases

- **Scanned/image-only PDF upload**: the system detects the missing text layer, tells the user explicitly, and asks for a text-based PDF or DOCX (no OCR in MVP).
- **Password-protected or corrupted file**: upload is rejected with a clear explanation of what is wrong and which formats are accepted.
- **Unusually structured CV** (heavy graphics, multi-column layouts, unusual section names): the parser extracts what it can, flags low-confidence or missing sections, and the user completes the profile manually via enrichment.
- **Varied date formats across the CV** (e.g., "01/2023", "Jan '23", "Sept 2021–Present", "janv. 2023", "sept. 2021 – aujourd'hui", "depuis 2020"): English and French formats are all normalized to YYYY-MM / "present"; ambiguous dates are flagged rather than guessed.
- **Re-uploading a second CV**: the user is asked whether to replace machine-parsed entries; user-entered entries are preserved and remain marked as user-provided.
- **Very short or vague job description** (no identifiable requirements): the system says it could not extract meaningful requirements and asks for the full JD text, rather than inventing requirements.
- **Semantically similar but hard-constrained requirement** (e.g., a required certification the user lacks but "almost" matches): it stays a gap unless the user explicitly confirms; approved aliases are the only sanctioned synonyms.
- **CV or job description in a language other than French or English**: processed best-effort with a clear notice that first-class support covers French and English only; the user may still proceed at their own risk or translate the input themselves.
- **Mixed-language CV** (e.g., French body with English technical skills and project names): the dominant language is detected as the profile language; technical terms are kept as written and remain matchable in both languages via normalization and the bilingual alias list.
- **Ambiguous or wrong language detection**: the detected language is always shown and user-correctable; correction updates profile metadata and downstream processing.
- **Accented French text in generated PDFs**: the text-extraction gate compares normalized text with accent and case insensitivity, so legitimate French accents never fail the export gate while genuinely missing content still does.
- **Untranslatable proper nouns and credentials**: employer, institution, and certification names are preserved verbatim; degrees and credentials are translated only via faithful official equivalents, and anything uncertain is flagged for user confirmation rather than improvised.
- **Invalid/expired key, exhausted quota, rate limit, or AI service outage mid-flow**: the system shows a specific, actionable error, preserves all work completed up to that stage (profile, JD, extracted requirements), and never substitutes fabricated content for failed AI output.
- **Async generation failure**: the job lands in a visible failed state with the error shown; completed stages are preserved; the user can retry.
- **Generation cannot fit the page budget even after trimming** (very extensive profile, minimal budget): the user is told explicitly and guided to increase the budget or trim the profile; no silent overflow.
- **Generated PDF fails the text-extraction completeness check**: the export is blocked and the document regenerated; a failing document is never offered for download.
- **Profile with little or no work experience** (recent graduate): generation works using education, projects, and skills.
- **Overlapping or conflicting employment dates in the profile**: the user is warned and asked to resolve the conflict before generation.
- **Names with diacritics and special characters**: preserved correctly in parsing and in the generated PDF.
- **Unusually long job description or profile exceeding model input limits**: the user is informed; no silent truncation of requirements.
- **Very long CV (beyond ~10 pages or model usable input)**: the user is warned and must explicitly confirm before any partial parsing; no silent truncation.
- **Text layer present but content-free extraction** (blank or garbage text): treated as a failed parse — an empty profile is created with a low-confidence flag and the user is directed to manual enrichment.
- **Duplicate profile entries on enrichment**: adding a skill or other entry that exactly duplicates an existing one prompts merge-or-keep, so matching is not skewed by duplicates.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept CV uploads in PDF and DOCX format up to 10 MB, and MUST reject unsupported formats or oversized files with a clear message stating what is accepted.
- **FR-002**: System MUST parse an uploaded CV — in French or English — into a structured profile covering basics (name, headline, summary, location, contact, links), work experience (role, employer, location, normalized dates, bullets, skills used), education, skills, languages, certifications, and projects.
- **FR-003**: System MUST record provenance for every parsed entry — source document and approximate location — MUST make provenance visible to the user on demand, and MUST visibly flag low-confidence parsed fields for review.
- **FR-004**: System MUST normalize all parsed dates to YYYY-MM (or "present") — recognizing English and French formats alike (e.g., "Jan 2023", "janv. 2023", "sept. 2021", "depuis 2020", "aujourd'hui"/"présent") — and MUST flag ambiguous dates rather than guessing.
- **FR-005**: System MUST provide full create/read/update/delete editing of every profile section with provenance tracking and autosave; corrections and additions MUST update provenance to user-entered/user-edited.
- **FR-006**: System MUST NOT infer skill proficiency levels from keyword presence; levels are user-stated only.
- **FR-007**: System MUST treat aliases (synonyms) as approved-only, sourced from exactly two places: a versioned built-in global list of vetted common aliases shipped with the application, and per-skill aliases explicitly approved by the user and stored on the Skill entry; matching MUST use the union of both, and any other synonymy MUST NOT count as an alias match. The built-in list MUST be bilingual, covering common French/English equivalents (e.g., "gestion de projet" ↔ "project management"), and alias matching MUST work across the two languages so a requirement stated in one language can match profile content in the other.
- **FR-008**: System MUST route all AI tasks through the user's own OpenRouter key, configurable via an in-app setting or an environment variable (single-user prototype), MUST validate the key before use, and MUST make model selection configurable per task with two-tier defaults: an economy-class model (fast/cheap) for parseCV, extractRequirements, and factGuard, and a premium-class model (strong writing) for generateTailoredCV and generateCoverLetter. System MUST enforce a per-application-run cost cap (default $0.50, user-adjustable) as a hard stop and MUST display token/cost usage per run.
- **FR-009**: System MUST treat the AI provider key as a secret — never displayed in full after saving, never written to logs, exports, or generated documents — and MUST minimize payloads sent to the provider to the profile and job-description text each task requires.
- **FR-010**: System MUST accept a pasted job description as plain text, with a minimum-length check and a clear error when the text is too short to analyze.
- **FR-011**: System MUST extract structured requirements from a job description in French or English, each with requirement text, a category, an importance level (must-have vs. nice-to-have — recognizing French markers such as "exigé/obligatoire" vs. "atout/un plus"), and a hard-constraint flag (required tools, certifications, licenses, explicit years of experience).
- **FR-012**: System MUST allow the user to review, correct, and remove extracted requirements before finalizing the match.
- **FR-013**: Matching MUST be deterministic and follow the ordered contract — exact, then approved alias, then semantic — where "exact" uses case- and accent-insensitive normalized comparison so French and English forms compare correctly; semantic matching applies only to non-hard requirements and MUST NOT satisfy a hard constraint unless the user explicitly confirms it; every match MUST cite evidence references to specific profile entries.
- **FR-014**: The Match Report MUST show, for every requirement: status (strong / partial / gap), match method (exact / approved alias / semantic / none), and evidence references; it MUST also provide an overall 0–100 score with a reproducible deterministic breakdown (hard requirements met, preferred met, exact/alias/semantic counts), plus recommended and missing keywords. The score MUST be computed as: hard-requirements bucket 60 points + preferred-requirements bucket 30 points + evidence bonus 0–10, where per-requirement credit is exact 1.0 / approved alias 0.9 / semantic 0.7 / partial status 0.5 / gap 0 (semantic credit never applies to hard constraints); each bucket scores its weight × (sum of credits ÷ number of requirements in the bucket), an empty bucket's weight shifts to the other bucket, the evidence bonus is 10 × (share of matched requirements whose evidence includes at least one experience or project bullet), and the final score is rounded to an integer.
- **FR-015**: CV and cover letter generation MUST run asynchronously with visible status and clear success/failure states, including retries and cancellation for generation jobs.
- **FR-016**: Content selection MUST be evidence-aware — ranking profile entries by relevance to the job, evidence strength, impact, and recency — without fixed bullet quotas; the page budget MUST be enforced as a layout constraint after content selection, and the user MUST be informed what was deprioritized.
- **FR-017**: Omissions from a generated CV MUST be recorded with type, identifier, and reason, and MUST be inspectable and reversible (the user can restore omitted items and regenerate).
- **FR-018**: A claim-level Fact Guard MUST validate every generated document: each material factual claim MUST link to supporting profile evidence (or explicit user confirmation); unsupported material claims MUST be raised as blocking flags that prevent download until resolved (edited/removed) or explicitly user-confirmed; the validation output MUST expose machine-readable codes, severities (blocker/warning), affected fields, evidence, and resolution state.
- **FR-019**: The MVP MUST ship one reliable single-column ATS-friendly CV template with standard section headings in the output language (Professional Summary, Experience, Education, Skills, optional Projects — or their standard French equivalents, e.g., "Résumé professionnel", "Expérience professionnelle", "Formation", "Compétences"); additional templates are deferred post-MVP.
- **FR-020**: Generated CVs MUST be rendered as PDFs with a real text layer, no essential information in headers/footers or images, and consistent normalized dates; the Skills section MUST surface exact and approved-alias matches using the job's terminology where supported.
- **FR-021**: Every generated document MUST pass a two-level automated text-extraction completeness check before download is offered, and failing exports MUST be blocked and regenerated: (1) 100% of structural elements — name, contact items, all standard section headings, and every experience entry's company/title/dates — must be recoverable from the PDF text layer; (2) every content block (bullet, summary, education entry) must achieve at least 95% word-level recovery under normalized (case-, accent-, whitespace-, and punctuation-insensitive) comparison against the source content, with identical rules applied for French and English outputs. DOCX export MUST also be available in MVP as a best-effort convenience output without the extraction gate (decided exception: the verification promise applies to the PDF deliverable).
- **FR-022**: The cover letter MUST complement rather than repeat the CV, MUST accept a tone setting and honor the selected output language, and MUST be subject to the same zero-invention rule and claim-level Fact Guard as the CV.
- **FR-023**: The cover letter MUST be available as a text-layer PDF and as copyable plain text.
- **FR-024**: System MUST allow regeneration with changed settings (tone, notes, page budget) without requiring re-entry of the profile or job description, and MUST keep generated document versions.
- **FR-025**: System MUST surface specific, actionable errors for AI provider failures (invalid key, exhausted quota, rate limit, service unavailable), MUST preserve work completed up to the failed step, and MUST NOT substitute fabricated content for failed AI output.
- **FR-026**: System MUST detect image-only (scanned) PDFs and reject them with guidance, without attempting OCR (out of MVP scope).
- **FR-027**: System MUST persist applications (job description, Match Report, generated documents, provenance, and versions) between sessions, and MUST allow the user to delete any of them. Every Match Report and generated document MUST record the profile version it was produced from, and generation jobs MUST operate on the profile snapshot taken at job start — later profile edits MUST NOT mutate in-flight or already-produced results.
- **FR-028**: A fixed, versioned evaluation benchmark (synthetic/anonymized profiles and job descriptions with expected matches, known unsupported claims that must be flagged, and formatting edge cases) MUST exist and be runnable with automated pass/fail thresholds before generator iteration; generator changes MUST NOT regress the benchmark. The benchmark MUST include French and English inputs and cross-language cases (French profile → English output, English JD → French profile, and the reverse).
- **FR-029**: The MVP MUST operate as a single-user, local-first application: no authentication, no multi-tenant isolation, local persistence, and the AI key MAY be supplied via environment variable (decided 2026-10-21; hosted multi-user is a separate later decision with its own security requirements).
- **FR-030**: System MUST detect the source language (French or English) of an uploaded CV and of a pasted job description, store it as metadata on the profile and the job analysis respectively, display the detected language to the user, and allow the user to correct it.
- **FR-031**: System MUST let the user choose the output language (French or English) for each CV and cover letter generation, independent of the profile's source language; when no choice is made, the output language defaults to the job description's detected language.
- **FR-032**: All generated narrative text (summary, bullets, cover letter body) and section headings MUST be produced in the selected output language; proper nouns (employer, institution, certification names) MUST be preserved verbatim, and only faithful translations of existing profile content are allowed.
- **FR-033**: Translation across languages is treated as rephrasing under fact-guarding: the Fact Guard MUST validate claims written in the output language against source-language profile evidence, and every number, date, duration, and metric MUST be identical between the profile and the translated output.

### Key Entities

Canonical schemas are defined in `ProfileForge-Specification.md` §4 (authoritative); the entities below describe them conceptually.

- **Profile**: The single source of truth for the user's career facts — basics, experience, education, skills, languages, projects, certifications — versioned, with IDs on every entry and the detected source language (French/English, user-correctable) stored as metadata.
- **Profile Entry / Bullet**: An atomic verifiable fact carrying provenance ("imported" from the uploaded CV with source location, "user_entered", or "user_confirmed") and, for parsed items, a confidence value; content is stored in its source language with language metadata.
- **Skill**: A named skill with optional category, user-approved aliases (union with the bilingual built-in global alias list; never freely inferred), and a user-stated level (never inferred).
- **AI Provider Key**: The user's own OpenRouter key (a secret) plus configurable model selection; used exclusively for AI tasks with minimized payloads.
- **Job Description / Job Requirement**: The pasted vacancy text with its detected language (French/English), and each extracted requirement with text, category, importance (must/nice), and hard-constraint flag.
- **Match Report**: The complete analysis of one job description against the profile: per-requirement results (status, match method, evidence references), an overall 0–100 score with reproducible deterministic breakdown, recommended keywords, and missing keywords; doubles as interview-prep material.
- **Evidence Reference**: A typed pointer (bullet / skill / education / certification) with a snippet, linking a match or a generated claim to the exact profile entry supporting it.
- **Generated Document Content (CV / Cover Letter)**: Structured generated content in the selected output language, where every bullet and summary carries links to its source profile entries, plus an inspectable, reversible list of omissions with reasons.
- **Validation Report (Fact Guard output)**: Claim-level flags with machine-readable codes, severity (blocker/warning), affected fields, supporting evidence, and resolution state (pending / user_confirmed / edited / removed); unresolved blockers gate export.
- **Application Record**: The persisted unit of one job application — job description, Match Report, generated document versions, provenance, and settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can go from CV upload to downloading a validated tailored CV and cover letter in a single sitting of 15 minutes or less (excluding AI processing wait time).
- **SC-002**: On a diverse sample of text-based CVs in French and English, at least 90% of clearly stated experience, education, and skill entries are parsed into the correct profile section with correct provenance, normalized dates, and correct source-language detection.
- **SC-003**: Across a sample audit of generated CVs and cover letters, 100% of material claims are traceable to profile evidence or explicit user confirmation — zero fabricated experience or metrics — and all known unsupported claims in the benchmark are flagged; this holds for cross-language outputs, where every number, date, and metric is identical to the profile after translation.
- **SC-004**: 100% of documents offered for download pass the two-level text-extraction gate: all structural elements (name, contact, headings, entry headers) recoverable, and every content block at ≥95% word-level recovery.
- **SC-005**: The Match Report accounts for 100% of extracted requirements — every requirement has a status, match method, and either evidence or a gap classification — and identical inputs always produce an identical score and breakdown.
- **SC-006**: For typical profiles, at least 90% of first-time CV generations fit the selected page budget without manual iteration; in remaining cases the user is clearly informed and guided, and omissions are always inspectable.
- **SC-007**: In moderated usability testing, at least 80% of participants complete the core flow (upload → job description → tailored CV download) without assistance.
- **SC-008**: 100% of tested failure paths (oversized file, image-only PDF, unsupported format, too-short job description, invalid key, exhausted quota, mid-generation AI failure) produce a clear, actionable error message rather than a dead end or silent failure.
- **SC-009**: The evaluation benchmark suite runs with defined automated thresholds, and no generator or matcher change ships that regresses those thresholds.
- **SC-010**: Language handling is verified end-to-end: source-language detection is correct for at least 95% of benchmark CVs and job descriptions, and benchmark cross-language generations (FR→EN and EN→FR) produce documents fully in the output language with zero fact drift.

## Assumptions

- `ProfileForge-Specification.md` (v0.5) is the authoritative product reference; this spec operationalizes it as feature requirements.
- Target documents (CVs and job descriptions) are in French or English, both first-class (decided 2026-10-21); any other language is processed best-effort with a notice that quality is not guaranteed.
- The application interface itself remains English-only in MVP; bilingual support covers document processing, matching, and generated outputs (CV, cover letter).
- The default output language is the job description's detected language; the user can always override to French or English regardless of profile or JD language (decided default).
- Profiles are stored in their source language with language metadata; translation happens at generation time — no dual-language profile storage is maintained.
- The match report displays requirements in the job description's language; report labels follow the (English) interface language.
- No OCR in the MVP: image-only PDFs are rejected with guidance to supply a text-based file.
- Accepted upload formats are PDF and DOCX with a 10 MB size limit; DOCX *export* is included in MVP as a best-effort, ungated convenience output — the verified deliverable is the PDF (decided 2026-10-21, an explicit exception to the verify-every-export principle, which continues to apply to all PDF exports).
- One CV template in MVP (single-column, standard headings); additional templates are deferred post-MVP per the authoritative reference.
- Single-user, local-first operation (decided 2026-10-21): no authentication, no multi-tenant isolation, local persistence; the OpenRouter key may be supplied via environment variable; encrypted key storage and tenant isolation belong to a future hosted-multi-user decision.
- Model selection is configurable per task with two-tier defaults (economy-class for parse/extract/validate, premium-class for generation) and a per-application-run cost cap of $0.50 by default (hard stop, user-adjustable) — decided 2026-10-21.
- Alias governance is the clarified hybrid model (versioned built-in global list plus per-skill user-approved aliases); score weights ship with the clarified defaults and may be recalibrated against the evaluation benchmark without changing the formula structure.
- Semantic matches never satisfy hard constraints without explicit user confirmation.
- Default page budget is 2 pages, configurable between 1 and 3, enforced as a layout constraint after evidence-aware content selection (no fixed bullet quotas).
- The cover letter is delivered as a text-layer PDF plus copyable plain text (for pasting into application forms).
- Out of MVP scope: automated job searching, job board integrations, embedding-based semantic expansion beyond the specified matching contract, interview-prep extensions beyond the Match Report, additional templates, multi-user hosting, and direct free-form editing of the rendered CV (refinement happens through profile edits, omissions restore, and regeneration settings).
- Users have a modern browser and stable internet; AI service availability and quota are the user's responsibility via their own key.
- Re-uploading a CV asks whether to replace machine-parsed entries; user-entered entries are always preserved.
