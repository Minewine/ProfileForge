# Feature Specification: Polish & Reliability Slice

**Feature Branch**: `006-polish-reliability`

**Created**: 2026-10-25

**Status**: Draft

**Input**: User description: "Polish and reliability slice: Fix any loading or error states found in smoke testing; Improve Fact Guard UX (clear messages when export is blocked); Add basic loading indicators during generation; Ensure the designed two-column template and the single-column ATS template both export cleanly."

**Context**: A live smoke test of feature 005 (upload → parse → import → match → generate → review) surfaced concrete UX and reliability gaps: AI-provider failures surface as a generic "temporarily unavailable" with no actionable detail; the profile date-overlap error tells users to "verify" a role although no verify action exists; the export-blocked state shows a blocker count but not what each gate requires or how to clear it; generation runs for ~1–2 minutes with only button-text feedback; and clean dual-template export has not been confirmed on real generated content in all supported languages.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Actionable failure messages (Priority: P1)

When something fails, the user sees a message that names what failed, why (to the extent known), and one concrete next step — never a bare "temporarily unavailable". This covers AI-provider failures (rejected key, exhausted credit, model unavailable, rate limited), generation-job failures (page-budget conflicts, export-gate failures), and profile conflicts (overlapping experience dates). The overlap message must stop referencing a nonexistent "verify" action and instead direct the user to the profile editor's date fields where the conflict is visibly flagged.

**Why this priority**: Every other flow dead-ends when an error is opaque — the smoke test needed developer-level investigation (manual API probing) to tell a dead model slug from an auth failure. Users cannot self-recover at all today.

**Independent Test**: Trigger each failure class (invalid key, zero credit, unavailable model, date overlap, page-budget conflict) and read only what the UI shows — each message must identify the failing step and a next action a user can perform without developer help.

**Acceptance Scenarios**:

1. **Given** the AI provider rejects the stored key, **When** any AI-backed action runs (CV parse, requirement extraction, generation), **Then** the UI says the key was rejected and links/points to the Settings page to fix it.
2. **Given** the provider reports exhausted credit, **When** a paid model call runs, **Then** the message names credit exhaustion as the cause and points to Settings/top-up guidance.
3. **Given** a model or provider is unreachable or misconfigured, **When** a call fails, **Then** the message says the AI provider is unavailable and offers retry, and the server-side record of the failure retains the provider's status/detail for diagnosis.
4. **Given** the profile has overlapping experience dates, **When** the user attempts generation, **Then** the conflict message names the overlapping-role problem and directs the user to edit the flagged date fields in the profile editor — with no reference to a "verify" action that does not exist.
5. **Given** a generation job fails (budget conflict or export gate), **When** the user views the job, **Then** the failure panel shows the machine code, a plain-language cause, and the suggested remedy already produced by the pipeline (raise budget / trim must-include / regenerate).

---

### User Story 2 - Understandable blocked exports (Fact Guard UX) (Priority: P1)

When a download is blocked, the user understands why and what will unblock it — per gate, in plain language. The blocked state distinguishes: (a) unresolved claim blockers (with the count and a direct entry point into the claim review list), (b) incomplete validation (the meaning-check layer could not run — download stays closed and the message says so), and (c) a failed document-verification render. Each pending blocker row explains in one sentence what kind of problem it is (e.g., numbers changed vs source, meaning drifted, unverified skill) and shows the three resolution actions (edit, remove, confirm) with guidance on when each is appropriate.

**Why this priority**: The smoke run produced 19 blockers; the UI correctly closed the download but gave only a count and a generic paragraph. A user facing "MEANING_DRIFT × 19" has no idea what to do. This is the core trust interaction of the product.

**Independent Test**: Generate a document with mixed pending flags, then check that the export area alone — without leaving the page — tells the user which gate is closed, how many claims block it, and what each resolution action does.

**Acceptance Scenarios**:

1. **Given** a document with unresolved blockers, **When** the user looks at the download area, **Then** it states that claims must be traced to the profile first, shows the blocker count, and scrolls/links directly to the claim review list.
2. **Given** pending blockers of different kinds (numeric mismatch, meaning drift, unverified skill), **When** the user reads the blocker list, **Then** each row carries a one-sentence plain-language explanation of that flag kind, not just the machine code.
3. **Given** the meaning-check layer could not run, **When** the user views downloads, **Then** the message states validation is incomplete (not that claims failed), that download is closed as a precaution, and what to do (regenerate or retry).
4. **Given** every blocker is resolved (edited, removed, or confirmed), **When** validation completes, **Then** the blocked state clears and download buttons enable without a page reload beyond the existing refresh.

---

### User Story 3 - Visible progress during generation (Priority: P2)

While a generation job is queued or running, and while data-heavy pages load, the user always sees that work is happening. The generation panel shows a clear in-progress state (not only button text), disabled controls indicate why they are disabled, and long-running AI steps communicate activity rather than silence. No async action leaves the page looking idle or finished while work continues.

**Why this priority**: Generation takes 1–2+ minutes. Today the only signal is button text ("Generating…") — easily missed, with no sense of progress or of which step is running. Lower priority than P1 because the flow does complete; the gap is perceived reliability, not function.

**Independent Test**: Start a generation and observe the panel continuously: an in-progress indicator is visible for the whole duration, controls are visibly disabled with reason, and the transition to the terminal state (succeeded/failed) is unmistakable.

**Acceptance Scenarios**:

1. **Given** a queued or running generation, **When** the user views the panel, **Then** a persistent progress indicator is visible alongside the status badge until the job reaches a terminal state.
2. **Given** a running job, **When** controls are disabled, **Then** their disabled state conveys why (generation in progress), not just greying.
3. **Given** a page whose data is still loading (analysis detail, document view), **When** content is not yet available, **Then** the page shows a loading state rather than an empty or finished-looking layout.

---

### User Story 4 - Clean dual-template exports (Priority: P2)

Both CV templates — the single-column ATS layout (default) and the designed two-column layout — export cleanly from the same generated content: the gate-verified PDF downloads for both, the companion document download works for both, text renders correctly in all supported output languages (French, English, German, including accented characters), and the chosen template is respected on every download rather than silently reverting.

**Why this priority**: Export is the product's deliverable; a template that fails verification or renders garbled text makes the whole pipeline moot. It is P2 only because automated tests already cover these paths — this story confirms them on real generated documents and closes any gap found.

**Independent Test**: Generate the same document with each template selected and attempt downloads: both templates produce a PDF that passes document verification and a companion document file, in each output language, with the template actually used matching the selection.

**Acceptance Scenarios**:

1. **Given** a completed generation with the ATS template, **When** the user downloads, **Then** the PDF and companion document download successfully and the PDF is the single-column layout.
2. **Given** a completed generation with the designed template, **When** the user downloads, **Then** both formats download successfully and the PDF shows the two-column layout (sidebar with contact/skills/languages).
3. **Given** output language French or German with accented characters, **When** either template's files are opened, **Then** text renders correctly (no mojibake, no dropped characters) in both formats.
4. **Given** the selected template, **When** regeneration or retry occurs, **Then** every subsequent download uses the same selected template unless the user changes it.

### Edge Cases

- AI provider fails mid-generation after earlier steps succeeded: the failure message identifies the step that failed and the user's prior work (profile, analysis, earlier versions) is untouched.
- A blocked export where the user confirms every claim as accurate: download unlocks through confirmations alone (no edits required).
- Generation finishes while the user is on another page or tab: on return, the panel shows the terminal state without requiring a manual reload.
- Both templates selected across consecutive regenerations of the same document: each version keeps its own template and downloads accordingly.
- Rate-limited provider during the meaning-check step: the job completes, the export stays closed with the "validation incomplete" explanation, and regeneration is offered.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST present AI-provider failures with cause-specific, actionable messages distinguishing at least: rejected key, exhausted credit, rate limiting, and general unavailability — each pointing to its remedy (Settings, retry, top-up guidance).
- **FR-002**: The system MUST retain the provider's failure detail (status and reason) in the server-side record of any failed AI call for later diagnosis, without exposing secrets.
- **FR-003**: The profile date-overlap conflict message MUST direct users to edit the flagged date fields in the profile editor and MUST NOT reference any unimplemented "verify" action.
- **FR-004**: Generation failure surfaces MUST show the failure code, a plain-language cause, and the pipeline's suggested remedy.
- **FR-005**: The export/download area MUST explain its state per closed gate: unresolved claim blockers (with count), incomplete validation, or failed document verification — each with the action that opens it.
- **FR-006**: Each pending claim flag MUST display a one-sentence plain-language explanation of its flag kind alongside its machine code.
- **FR-007**: Resolution actions (edit, remove, confirm) MUST remain available directly from the blocked-export context, and the blocked state MUST clear when the last blocker resolves.
- **FR-008**: The generation panel MUST show a persistent progress indicator while a job is queued or running, and disabled controls MUST state the reason they are disabled.
- **FR-009**: Data-loading views MUST show a loading state until their content is available.
- **FR-010**: Both CV templates MUST produce downloadable files (verified PDF plus companion document) from the same content, and the downloaded files MUST reflect the template selected for that version.
- **FR-011**: Downloads in French, English, and German MUST render all text correctly in both templates and both file formats.

### Key Entities

- **Failure notice**: user-facing message bound to a failure class (provider cause, pipeline stage, profile conflict), carrying a code, a plain-language cause, and a next action.
- **Export gate state**: the download area's condition derived from claim validation results and document verification — blockers-pending, validation-incomplete, verification-failed, or open.
- **Claim flag explanation**: the plain-language description attached to each flag kind shown during claim review.
- **Template selection**: the per-version choice of CV layout (single-column ATS default, two-column designed) that governs all downloads of that version.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every user-visible failure message in the upload → analyze → match → generate → download flow names the failing step and exactly one concrete next action (verified by walking each failure class from the smoke test).
- **SC-002**: A user facing a blocked export can determine, from the download area alone, which gate is closed and what action opens it — without developer knowledge (checklist-verified on a mixed-flag document).
- **SC-003**: During generation, some visible progress indication is present at all times from start to terminal state; there is no period where the panel appears idle or finished while the job runs.
- **SC-004**: For the same generated content, both templates download successfully in PDF and companion format across French, English, and German — 100% of attempted downloads succeed and openable files match the selected template.

## Assumptions

- Implementing a date-overlap "verify" mechanism (accepting an overlap as intentional) is out of scope; this slice only fixes the message to point at the existing edit path.
- The existing claim resolution actions (edit / remove / confirm) are sufficient as the unblocking path; no new resolution actions are added.
- Progress indication is presentational: exposing finer-grained pipeline stage detail beyond queued/running is not required for this slice.
- Automated coverage for dual-template export already exists; this slice's work is confirming it on real content and closing gaps, not rebuilding renderers.
- Single-user local deployment; no new telemetry or analytics infrastructure is introduced.
