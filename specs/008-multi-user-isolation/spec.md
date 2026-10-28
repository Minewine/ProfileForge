# Feature Specification: Multi-User Support with Per-User Isolation

**Feature Branch**: `008-multi-user-isolation`

**Created**: 2026-10-26

**Status**: Draft

**Input**: User description: "Add multi-user support so each user has their own isolated profile. Scope: user registration and login (email + password, or magic link if simpler); each authenticated user gets their own Profile, CVs, MatchReports, and generated documents; existing single-user local data migratable or cleanly separated; OpenRouter API key remains per-user (stored encrypted, as today); all current features work unchanged once a user is logged in; unauthenticated users see only login/register; keep the implementation as simple as possible for an MVP (no teams, no sharing, no roles beyond basic user)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register, Log In, and Reach a Private Workspace (Priority: P1)

A visitor can create an account with an email address and a password, log in, and land in their own empty workspace. While logged out, every part of the application shows only the sign-in/registration experience — no profiles, no uploads, no jobs, no settings.

**Why this priority**: Nothing else in this feature can exist without accounts; this is the gate every other story builds on.

**Independent Test**: Register a new account, log out, log back in with the same credentials; the workspace is reachable and empty. Fully testable without any other story.

**Acceptance Scenarios**:

1. **Given** no account exists for an email address, **When** a visitor registers with that email and a valid password, **Then** the account is created, the user is signed in, and they see their own empty workspace.
2. **Given** an unauthenticated visitor opens any application page (home, profile editor, upload, jobs, settings) or triggers any data action, **When** the request is processed, **Then** they are shown only the login/registration experience and no application data is revealed.
3. **Given** a registered user, **When** they log out and later log in with the correct email and password, **Then** they return to their own workspace with all their data intact.
4. **Given** a registered user, **When** they attempt to log in with a wrong password, **Then** sign-in fails with a clear error message and no session is created.

---

### User Story 2 - Each User Sees Only Their Own Data (Priority: P1)

Once logged in, every screen and every action operates exclusively on the signed-in user's own profile, uploaded CVs, job analyses and match reports, generation jobs, and generated documents. Other accounts' data is invisible and unreachable — even by guessing identifiers, bookmarking someone else's URLs, or calling data operations directly.

**Why this priority**: Isolation is the core reason this feature exists; without verified isolation, multi-user support would be unsafe to ship.

**Independent Test**: Create two accounts A and B; as A, upload a CV, run a JD match, and generate a document; log in as B and confirm none of A's data appears anywhere and A's resource addresses are inaccessible from B.

**Acceptance Scenarios**:

1. **Given** user A has uploaded CVs, job analyses, and generated documents, **When** user B lists their uploads, jobs, or documents, **Then** only B's own items appear.
2. **Given** user B knows or guesses the identifier of one of A's resources, **When** B requests that resource's page or data operation, **Then** the system behaves as if the resource does not exist (no content, and no confirmation that it exists).
3. **Given** user A is signed in, **When** A uses any existing feature (CV upload and parsing, profile editor with version history and restore, JD analysis and matching, CV and cover-letter generation, claim confirmation and omission restore (Fact Guard), document download, templates), **Then** each works with the same behavior as before this feature.

---

### User Story 3 - Per-User OpenRouter Key and Settings (Priority: P2)

Each account stores its own OpenRouter API key (encrypted, as today) plus its model preferences and spending cap. Generation and matching run with the signed-in user's key and limits, and usage is attributed to that user. One user's key, models, or spend never affects another's, and no user can retrieve anyone's key in plaintext.

**Why this priority**: Billing and cost control become personal once multiple people share an installation; it depends on the account model (Story 1) but not on data migration.

**Independent Test**: Save different API keys as users A and B, run a generation as each, and confirm each run uses its owner's key and spending cap; confirm neither user can view the other's key in plaintext.

**Acceptance Scenarios**:

1. **Given** user A has saved an API key, **When** user B opens settings, **Then** B sees only B's own key state (e.g., a saved-key hint) and cannot obtain A's key in plaintext by any means.
2. **Given** users A and B have different keys and spending caps, **When** each runs a generation, **Then** each run uses that user's key and is limited by that user's cap.
3. **Given** a user has not saved a key, **When** they attempt an action that needs one, **Then** they are prompted to add their key in settings, as today.

---

### User Story 4 - Existing Single-User Data Is Migrated or Quarantined (Priority: P2)

Data that existed before this feature — the original single-user workspace (profile, uploaded CVs, job analyses, generated documents) — is either cleanly attached to one designated account or kept quarantined until claimed. In both cases it is never exposed to the wrong user, and the designated owner regains full access to it.

**Why this priority**: Protects existing local data at rollout without blocking the new account flows; can land after Stories 1–3 without changing them.

**Independent Test**: After upgrading, designate/register the owner account and confirm all pre-existing data is fully usable from that account and invisible from any other account.

**Acceptance Scenarios**:

1. **Given** pre-existing single-user data, **When** the designated owner logs in, **Then** all prior profiles, uploaded CVs, job analyses and match reports, generation jobs, and generated documents with their versions are present and fully usable.
2. **Given** a different account, **When** it lists or requests any pre-existing data, **Then** nothing pre-existing is visible or accessible.
3. **Given** pre-existing data whose designated owner has not yet registered, **When** any other user uses the application, **Then** the pre-existing data remains inaccessible (quarantined) until its owner claims it.

---

### Edge Cases

- What happens when someone registers with an email that already has an account? Registration is rejected with a clear message; no partial account or data is created.
- What happens at sign-in with a wrong password or an unknown email? A generic failure message is shown that does not reveal whether the email exists.
- What happens when a session expires or is invalidated mid-use? The user is redirected to login; no data is lost; after re-login their workspace is intact.
- What happens when the same user is signed in from two browsers at once? Both sessions work; data stays consistent.
- What happens if a user logs out while a generation is running? The job continues and completes server-side; the result is visible when they log back in.
- What happens when a bookmarked URL or identifier belonging to another user is opened? It is treated as not found — never an error that reveals existence, never content.
- What happens when unauthenticated requests hit data operations directly? They are rejected without returning any application data.
- How are case and whitespace variations of an email handled ("A@x.com" vs "a@x.com ")? They refer to the same account, consistently, everywhere.
- What prevents weak credentials? A minimum password requirement is enforced at registration; passwords are never stored or logged in readable form.
- What about uploaded CV files and generated artifacts stored on the server? They are served only to their owner.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow visitors to create an account using an email address and a password (or a simpler credential mechanism such as an emailed sign-in link, if chosen at planning time).
- **FR-002**: System MUST allow registered users to sign in with their credentials and to sign out.
- **FR-003**: System MUST keep a user signed in across visits until they sign out or their session expires after a generous period.
- **FR-004**: System MUST restrict every application page and data operation to signed-in users; unauthenticated access shows only the login/registration experience and never application data.
- **FR-005**: System MUST scope every Profile (with its sections, bullets, and snapshots), uploaded CV/source document, job analysis and match report, generation job, generated document and its versions, and every uploaded or generated file to exactly one account — for listings and direct access alike.
- **FR-006**: System MUST treat any request for another user's resource as "not found", never revealing its existence or content.
- **FR-007**: System MUST store each user's OpenRouter API key encrypted under that user's settings, and MUST NOT return the key in plaintext after it is saved (a non-secret hint may be shown).
- **FR-008**: System MUST apply each user's own model preferences and spending cap to their LLM usage and MUST attribute usage records to the signed-in user.
- **FR-009**: System MUST provide a way to migrate pre-existing single-user data to one designated account, or keep it quarantined until claimed; in either case it MUST NOT be visible to any other account.
- **FR-010**: All existing capabilities — CV upload and parsing, profile editing with version history and restore, JD analysis and matching, CV and cover-letter generation, claim confirmation and omission restore (Fact Guard), document download, and templates — MUST work for a signed-in user with the same behavior as before this feature.
- **FR-011**: System MUST support exactly one role ("user") and one private workspace per account; no teams, sharing, additional roles, or admin capabilities in this version.
- **FR-012**: System MUST prevent creating a second account for an email that already has one, comparing emails after case and whitespace normalization.
- **FR-013**: System MUST NOT store or transmit passwords in readable form, and MUST NOT log credentials or API keys.

### Key Entities *(include if feature involves data)*

- **User Account**: A person's identity — a unique email address, a secret credential (never stored readably), and creation date. Owns exactly one private workspace.
- **Per-User Settings**: Each account's encrypted OpenRouter API key, optional key hint, model preferences, and spending cap. Replaces the current single global settings record.
- **Workspace Data** (each item scoped to exactly one account): the Profile with all its sections (experiences, education, skills, languages, projects, certifications, bullets) and version snapshots; source documents (uploaded CVs and their extracted content); job analyses with requirements and match reports; generation jobs; generated documents with their versions, confirmations, and artifacts.
- **Usage Records**: Per-LLM-call token/cost records attributed to the owning account, used to enforce that account's spending cap.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can go from "no account" to a signed-in, empty private workspace in under 2 minutes.
- **SC-002**: A returning user reaches their workspace within 15 seconds of starting sign-in.
- **SC-003**: In automated isolation tests with at least two concurrent accounts, 100% of cross-account access attempts (listings and direct access) are denied or treated as not found — zero data leakage.
- **SC-004**: All pre-existing features complete successfully for a signed-in user with zero regressions against the existing test suite and GUI flows.
- **SC-005**: 100% of pre-existing single-user data is accessible to its designated owner after the upgrade, and 0% is visible to any other account.
- **SC-006**: Saved API keys are retrievable in plaintext by no one — zero plaintext key exposures in any response, log, or error message.

## Assumptions

- **Email + password** is the working assumption for credentials; magic-link sign-in is an acceptable alternative only if planning shows it is genuinely simpler, since it requires an email-delivery service that adds operational complexity contrary to the MVP-simplicity goal.
- Sessions persist across browser restarts for convenience, with explicit sign-out available; separate "remember me" behavior and configurable session lifetimes are out of scope.
- The current application implicitly operates on a single workspace (it resolves "the" profile as the first one and settings as a singleton). Multi-user support means exactly one workspace per account; multiple profiles per user remains out of scope.
- One designated owner is chosen for pre-existing data (for example, the original local user, who registers with a known email); the upgrade path may attach the data at migration time or quarantine it until that account claims it.
- Account deletion, password reset/recovery, and email verification are out of scope for this MVP and can follow later.
- Uploaded files and generated artifacts keep their current storage approach; only access control changes.
- The repository's constitution file is an unfilled template; no additional governance constraints apply yet.
