# Feature Specification: Fix Profile Editor CRUD

**Feature Branch**: `007-fix-profile-editor-crud`

**Created**: 2026-10-26

**Status**: Draft

**Input**: User description: "Investigate and fix the profile editor so users can add, edit, and remove entries. Current problem: on /profile existing fields cannot be changed; new bullets cannot be added to experience entries; adding skills, languages, or other items does not work. Requirements: full CRUD on Experience (including bullets), Education, Skills, Languages, and other profile sections; autosave must persist changes and survive a page reload; clear error messages if a save fails; do not break existing generation, Fact Guard, or template export behavior."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edit existing profile content and have it persist (Priority: P1)

A job seeker opens the profile editor and corrects existing content — a typo in a company name, an outdated date, a reworded achievement bullet, a contact detail. The change saves automatically shortly after they stop typing and is still present after they reload the page. Editing one thing never disturbs anything else: bullets stay attached to their experience entry, sibling fields keep their values, the shown order of entries does not change, and entries the user previously confirmed or that were imported from a document remain editable with their origin labels intact.

**Why this priority**: This is the most-reported breakage ("existing fields cannot be changed") and the core promise of the editor. Every other workflow — generation, Fact Guard, export — depends on edits actually being saved.

**Independent Test**: Load the seeded profile, change one field in each section (basics plus every entry type) and one bullet, then reload and verify every change persisted while everything else is untouched.

**Acceptance Scenarios**:

1. **Given** an experience entry that has two bullets, **When** the user changes the company name and reloads, **Then** the new company name is shown and both bullets are still present, unchanged.
2. **Given** an entry the user has confirmed, **When** the user edits any of its fields, **Then** the edit saves successfully and the entry remains editable (no error is shown).
3. **Given** an imported entry, **When** the user edits one of its fields, **Then** the edit saves and the entry keeps its imported-origin labeling and review metadata.
4. **Given** a basic detail (name, email, phone, link), **When** the user changes it to a valid value and reloads, **Then** the new value is shown.
5. **Given** an achievement bullet, **When** the user rewords it and reloads, **Then** the reworded text is shown.
6. **Given** the user edits one field of an entry, **When** the save completes, **Then** every other field of that entry (dates, location, skills used, position in the list) retains its previous value.

---

### User Story 2 - Add new entries and bullets in every section (Priority: P1)

The job seeker can grow their profile from the editor: "+ Add" in every section (experience, education, skills, languages, projects, certifications) creates a new immediately editable row that persists once filled in; "+ Bullet" on an entry that supports bullets creates an empty bullet the user can type into, and the typed text remains and persists. Adding works even when the section is currently empty. Adding a skill whose name already exists is refused with the existing duplicate-skill explanation rather than creating a silent duplicate.

**Why this priority**: Adding content is currently broken for every section except experience, and bullet adding never persists — without this the editor cannot build a profile, only trim one.

**Independent Test**: In a profile where each section is empty, add one entry to every section, fill in required fields, add two bullets to the new experience entry, reload, and verify all of it persisted. Then attempt to add a duplicate skill and verify the duplicate message appears.

**Acceptance Scenarios**:

1. **Given** any section (including an empty one), **When** the user clicks "+ Add" and fills in the required fields, **Then** the new entry appears in the section and persists after reload.
2. **Given** an experience entry, **When** the user clicks "+ Bullet" and types text, **Then** the text stays visible while typing and persists after reload.
3. **Given** the skills section, **When** the user adds a skill name that already exists, **Then** the duplicate-skill message is shown and no duplicate skill is created.
4. **Given** a newly added entry, **When** the user saves other edits elsewhere before filling the new entry in, **Then** the new entry is still there afterwards.

---

### User Story 3 - Remove entries and bullets (Priority: P2)

The job seeker can delete any entry in any section and any individual bullet. Removal persists after reload, removes only what was targeted, and deleting an entry also removes its bullets so nothing is left dangling. A section that becomes empty shows its empty state and can still accept new additions.

**Why this priority**: Completes full CRUD; removal is a smaller share of editing time but a hard requirement for correcting imported content.

**Independent Test**: For each section, delete one entry and one bullet on another entry, reload, and verify the removals persisted and all other content is intact.

**Acceptance Scenarios**:

1. **Given** an entry in any section, **When** the user deletes it and reloads, **Then** it is gone and the remaining entries are unchanged.
2. **Given** an entry with bullets, **When** the user deletes the entry, **Then** its bullets are removed with it.
3. **Given** an entry with three bullets, **When** the user removes one bullet and reloads, **Then** only that bullet is gone.
4. **Given** the last entry in a section is deleted, **Then** the section shows its empty state and "+ Add" still works.

---

### User Story 4 - Clear feedback for every save outcome (Priority: P2)

The editor always tells the truth about what has been saved. Successful saves show the existing saved indication; failed saves (validation rejection, server error, connection loss) show a visible, human-readable error that names the item or field involved and the reason — for example that a name cannot be empty or an email is malformed. A failed save is never silent, and the editor does not quietly revert what the user typed without telling them. Non-blocking warnings from the system (such as overlapping date ranges) are displayed while still allowing the save.

**Why this priority**: Silent failures are what made the current bugs feel like "nothing works". Visible errors are required for the user to trust — and recover from — any save outcome.

**Independent Test**: Trigger each failure mode deliberately (empty required field, invalid email, duplicate skill, simulate an unreachable server), verify a visible and specific error appears each time, and verify a reload afterwards shows the last successfully saved state.

**Acceptance Scenarios**:

1. **Given** the user clears the required name field, **When** autosave attempts to save, **Then** a visible error names the field and the reason, and the editor does not silently discard the input without notice.
2. **Given** the user enters a malformed email, **When** autosave attempts to save, **Then** a visible error explains the email is invalid.
3. **Given** the server is unreachable or returns an error, **When** any save fails, **Then** a visible error appears naming the failed item, and the saved/saved-status indicator shows the failure state.
4. **Given** an edit that produces a non-blocking warning such as overlapping experience dates, **When** the save completes, **Then** the warning is displayed to the user and the change is still saved.
5. **Given** a successful save, **Then** the existing saved indication behaves as it does today.

---

### User Story 5 - Edits remain fully usable by generation, Fact Guard, and export (Priority: P2)

After any add, edit, or removal, the rest of the product keeps working against the edited profile: CV generation for a job succeeds and reflects the edited content, Fact Guard continues to check generated claims against the current bullet and entry content, template export renders the edited profile, and every change continues to create a restorable point-in-time version. A profile restored from version history is immediately editable, with the same CRUD guarantees as live content.

**Why this priority**: This is an explicit non-regression constraint from the request; it is testable as a user journey ("edit, then generate") and must hold for every story above.

**Independent Test**: Make a representative set of edits (edit a field, add a bullet, delete an entry), then run generation, a Fact Guard check, and a template export, and verify all three succeed and use the edited content; restore an older version and repeat the edits from User Story 1 on the restored data.

**Acceptance Scenarios**:

1. **Given** a profile with edits made through the editor, **When** the user generates a CV, **Then** generation succeeds and the output reflects the edited content.
2. **Given** a profile with edited or newly added bullets, **When** Fact Guard validates a generated CV, **Then** it evaluates claims against the current bullet and entry content.
3. **Given** a profile with edits, **When** the user runs template export, **Then** the export succeeds and includes the edited content.
4. **Given** any sequence of CRUD operations, **When** the user opens version history, **Then** each change was recorded and any version can be restored.
5. **Given** a restored version, **When** the user edits any of its entries or bullets, **Then** the edits save and persist like any other content.

---

### Edge Cases

- What happens when the user makes two quick successive edits to different fields of the same entry (e.g., company then title within the autosave window)? Both edits must persist; neither may be overwritten by a stale copy of the other.
- What happens when the user clears an optional field (a date, location, grade)? The field must save as empty — clearing must not produce a validation error, and the cleared value must persist.
- What happens when the user is mid-typing a partial date (e.g., has typed only the year)? The editor must not flood the user with errors for incomplete input; errors appear only for values that are still invalid when a save is attempted.
- What happens to a newly added bullet that the user leaves empty? It is not persisted as an error — an empty bullet is saved only once it contains text, or is discarded if abandoned empty (see Assumptions).
- What happens when the user reloads while a save is still in flight? No corruption and no lost confirmed saves; the outcome of the last completed save is what the user sees.
- What happens when the user deletes content while a save of that same content is in flight? The final state must match the user's last action, not a stale save.
- What happens when a save fails and the user keeps editing? Further edits still attempt to save; the earlier failure remains visible until resolved or superseded.

## Requirements *(mandatory)*

### Functional Requirements

**Editing and persistence**

- **FR-001**: The system MUST allow the user to edit every field of the basic profile details and every field of every existing entry in all sections (experience, education, skills, languages, projects, certifications), with each change autosaved shortly after the user stops typing and persisted across page reloads.
- **FR-002**: The system MUST save only the field(s) the user actually changed — saving one field MUST NOT alter the entry's other fields, reset its position among its siblings, or delete or recreate its bullets.
- **FR-003**: The system MUST allow editing of entries regardless of their origin or confirmation status (imported, user-entered, or user-confirmed), and MUST preserve imported-origin and review metadata when an imported entry is edited rather than resetting it.
- **FR-004**: The system MUST allow the user to reword an existing bullet's text, preserving that bullet's position and its neighbors.
- **FR-005**: The system MUST allow the user to clear an optional field (dates, location, grade, proficiency, link, category, level) so that it saves as empty without error.

**Adding**

- **FR-006**: The system MUST provide a working "+ Add" action in every section — experience, education, skills, languages, projects, and certifications — that creates a new immediately editable entry (with sensible placeholder content where a field is required), even when the section is currently empty.
- **FR-007**: The system MUST provide a working "+ Bullet" action on entries that support bullets, creating a new empty bullet the user can type into without the text reverting while typing, and persisting the bullet once it has content.
- **FR-008**: The system MUST continue to refuse adding a skill whose name duplicates an existing skill, with the existing duplicate-skill explanation, reachable through the normal UI flow.

**Removing**

- **FR-009**: The system MUST allow the user to delete any entry in any section, with the removal persisted across reloads and remaining entries untouched.
- **FR-010**: The system MUST delete a deleted entry's bullets along with it (no orphaned bullets).
- **FR-011**: The system MUST allow the user to remove an individual bullet, removing only that bullet.

**Feedback and error handling**

- **FR-012**: The system MUST display a visible, human-readable error message for every failed save — whether caused by validation (e.g., empty required field, malformed email), a server error, or a lost connection — within about two seconds of the failed attempt; failure must never be silent.
- **FR-013**: Error messages MUST identify the item or field involved and the reason (e.g., "Experience at Acme: company name cannot be empty"), not a generic "Save failed" alone.
- **FR-014**: When a save fails, the editor MUST NOT silently revert or discard the user's input without informing them; the last successfully saved state must be what a reload shows.
- **FR-015**: The save-status indicator MUST reflect all three outcomes — saving, saved, failed — for both basic details and per-section entry saves.
- **FR-016**: The system MUST display non-blocking warnings returned with a successful save (e.g., overlapping experience dates) while still completing the save.

**Integrity and non-regression**

- **FR-017**: Every successful add, edit, and removal MUST continue to be recorded as a restorable version, preserving the existing version-history behavior.
- **FR-018**: After any CRUD operation, CV generation, Fact Guard validation, and template export MUST continue to work against the edited profile and reflect its current content, with no changes to their existing behavior.
- **FR-019**: Restoring a version from history MUST produce content that is fully editable under the same rules as live content.
- **FR-020**: Consecutive edits to different fields (including rapid successive edits within the autosave window) MUST all persist — no edit may be lost to a stale overwrite.

### Key Entities *(include if feature involves data)*

- **Profile**: The single user profile — basic contact details (name, email, phone, links), preferred language, and a version number that increments with every change.
- **Experience**: A work role (company, title, location, start/end dates, skills used) with an ordered position and attached achievement bullets.
- **Bullet**: A single achievement line of text attached to an experience, project, or education entry, with an ordered position among its siblings.
- **Education**: A study record (institution, degree, field, grade, dates) with an ordered position and optional bullets.
- **Skill**: A named capability with an optional category, aliases, and user-stated level; names must be unique within the profile.
- **Language**: A named language with an optional proficiency level.
- **Project**: A named project with description, link, dates, and bullets.
- **Certification**: A certification (title, issuer, issue date).
- **Provenance**: Per-entry and per-bullet origin tracking (imported from a document, user-entered, or user-confirmed) with associated review metadata; editing content must not erase this history.
- **Profile Version (snapshot)**: An immutable point-in-time copy of the whole profile written on every change, listed in version history and restorable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an end-to-end pass, 100% of CRUD operations succeed and persist across reload: editing every field type in every section, adding one entry to each of the six sections, adding and editing and removing bullets, and deleting entries.
- **SC-002**: Editing any field of an entry that has bullets preserves all of that entry's bullets 100% of the time (verified by automated tests that edit a field first and then check bullet survival).
- **SC-003**: 100% of deliberately triggered save failures (invalid value, duplicate skill, unreachable server) produce a visible, specific error message within 2 seconds.
- **SC-004**: An autosaved change is persisted on the server within about 2 seconds of the user's last keystroke, and survives an immediate reload.
- **SC-005**: A user can add a complete new experience entry — company, title, dates, and three typed-out bullets — from scratch in under 2 minutes with no errors.
- **SC-006**: Zero regressions: the existing automated suites for generation, Fact Guard, template export, version history, and the profile editor pass unchanged after the fix, and the documented-broken editor scenarios in the current end-to-end tests pass without their workarounds.
- **SC-007**: A restored historical version accepts edits that save and persist exactly like live content.

## Assumptions

- This is a single-user local application; concurrent editing from multiple browser tabs or devices is out of scope for this fix.
- The fix reuses the existing profile data model, editor layout, autosave behavior (roughly one second after typing stops), and version-snapshot mechanism — no redesign of the editor UX or the downstream consumers (generation, Fact Guard, export).
- A newly added bullet is persisted only once it contains text; an empty bullet abandoned by the user is discarded rather than saved as an error. Newly added entries, by contrast, are persisted immediately with placeholder content (matching today's experience-entry behavior).
- "Other profile sections" means projects and certifications, alongside experience, education, skills, and languages.
- Non-blocking warnings (e.g., overlapping dates) are displayed but never block saving, matching current server behavior.
- Mobile/responsive behavior is unchanged by this fix.
