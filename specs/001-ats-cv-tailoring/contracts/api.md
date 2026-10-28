# API Contract: Slice 1 (Next.js Route Handlers)

All request/response bodies are JSON unless noted; every body is zod-validated at the edge. Errors use a single envelope:

```json
{ "error": { "code": "FILE_TOO_LARGE", "message": "…human-readable, actionable…", "details": {…} } }
```

Error codes (slice 1): `FILE_TOO_LARGE`, `UNSUPPORTED_FORMAT`, `NO_TEXT_LAYER`, `CORRUPT_FILE`, `PARSE_FAILED`, `LLM_KEY_INVALID`, `LLM_QUOTA`, `LLM_RATE_LIMITED`, `LLM_UNAVAILABLE`, `LLM_SCHEMA_REPAIR_FAILED`, `COST_CAP_REACHED`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFIRMATION_REQUIRED`, `SOURCE_IN_USE`, `DUPLICATE_SKILL`.

Module interfaces from `ProfileForge-Specification.md` §3 map as: `importFromCV()` → upload+parse+import routes; `getProfile()` / `updateProfileSection()` → profile routes; `parseCV(file)` → parse route + task contract (parsecv-task.md).

## CV ingestion

### POST /api/cv/upload  (multipart/form-data, field `file`)
Fast path (<5 s): save, hash, extract text, detect language. No LLM call.
- **Guards** (FR-001/FR-023): ≤10 MB; MIME ∈ {application/pdf, DOCX}; image-only PDF (`unpdf` yields ~no text) → `NO_TEXT_LAYER`.
- **200** → `{ sourceDocumentId, detectedLanguage: "fr"|"en", pageCount|paragraphCount, charCount, requiresPartialParseConfirmation: boolean, parseStatus: "unparsed" }` — `requiresPartialParseConfirmation` is true when the CV exceeds the ingestion threshold (PDF: >10 pages; any format: extracted text >60,000 characters); parsing then covers the leading 10 pages only and requires explicit confirmation (spec edge case "Very long CV" — never silent truncation).
- **415/413/422** → error envelope.

### PATCH /api/cv/{sourceDocumentId}  `{ language: "fr" | "en" }`
Corrects a misdetected document language before parsing (spec US1 scenario 6): updates `SourceDocument.detectedLanguage`; the parse prompt and date-normalization hints use the corrected value. Does not retroactively alter an already-produced draft — re-parse to apply.

### DELETE /api/cv/{sourceDocumentId}
Deletes the source-document record and stored file. **204** when no `imported` entries reference it; **409 `SOURCE_IN_USE`** otherwise, with `affectedEntryIds` — referenced entries must first be re-attributed (edit → `user_entered`) or deleted. This keeps provenance from ever dangling (FR-024 deletion guarantee).

### POST /api/cv/{sourceDocumentId}/parse
Runs `parseCV` (LLM, ≤120 s — see parsecv-task.md) using the document's (correctable) detected language, then the deterministic post-pass: date normalization, source-containment check, low-confidence flagging.
Request body: `{ confirmPartial?: boolean }` — must be `true` when the upload flagged `requiresPartialParseConfirmation`; otherwise **422 `CONFIRMATION_REQUIRED`**.
- **200** → `{ parseStatus: "parsed", draft: ProfileDraft, flags: LowConfidenceFlag[], partial?: true, omittedPages?: [n..m] }` where `ProfileDraft` mirrors `Profile` sections with provenance refs into this source document; `partial` + `omittedPages` mark a confirmed partial parse and what was left out.
- Re-parse of an already-parsed doc is allowed (idempotent replacement of `parseResult`).
- **424/502** → `PARSE_FAILED` / LLM error codes (see llm-router.md taxonomy).

### POST /api/profile/import  `{ sourceDocumentId, mode: "replace_parsed" | "merge" }`
- `replace_parsed`: removes existing `imported` entries, **preserves all `user_entered`/`user_confirmed` entries** (spec assumption), inserts draft entries, bumps version (cause `import`).
- `merge`: inserts draft entries alongside existing ones (duplicate skill names trigger merge-or-keep prompts client-side).
- **200** → `{ profileId, version, imported: {experience: n, …}, preservedUserEntries: n }`

## Profile

### GET /api/profile → `{ profile: ProfileDTO, lowConfidenceCount: n, hasDraftAwaitingImport: boolean }`

### PATCH /api/profile  `{ basics?, language? }`
Language correction updates `Profile.language` (FR-030) and re-runs nothing (extraction is language-independent; only display + future parsing hints change).

### POST /api/profile/entries/{section}   body = section-specific create payload
### PATCH /api/profile/entries/{section}/{entryId}  (autosave target; partial fields)
### DELETE /api/profile/entries/{section}/{entryId}
`section ∈ {experience, education, skills, languages, projects, certifications}`. PATCH is idempotent and debounced client-side (~800 ms); every mutation returns `{ version, warnings?: [{ code, message }] }` (version bumped; e.g., `DATE_RANGE_OVERLAP` when edited dates conflict — warned, not blocked) and is transactional with a snapshot append. Bullet children of experience/project/education are edited through their parent entry payload (bullet arrays with per-bullet ids; new bullets get server ids).

**Provenance transitions** (PATCH `{ provenance }`): `imported → user_confirmed` is valid only for entries with open review flags (low-confidence or failed containment) and clears the flag — the user's explicit confirmation path (FR-018 resolution groundwork); `user_entered ↔ user_confirmed` allowed; transitions never fabricate a source ref.

**Duplicates**: `POST /api/profile/entries/skills` with a case/accent-insensitive duplicate name → **409 `DUPLICATE_SKILL`** `{ existingId }`; the client renders merge-or-keep (spec edge case).

### GET /api/profile/versions → `{ versions: [{ version, cause, createdAt }] }`
### POST /api/profile/versions/{version}/restore → restores snapshot (bumps version, cause `restore`)

## Settings

### GET /api/settings → `{ keyConfigured: boolean, keyHint: "sk-or-…f4a2" | null, keySource: "env" | "db", modelEconomy, modelPremium, costCapUsd }`
Never returns the full key (FR-007/FR-009).

### PUT /api/settings `{ openRouterKey?, modelEconomy?, modelPremium?, costCapUsd? }`
Storing a key validates it first, but only a **definitively invalid** key (auth rejected, 401/403) blocks saving; a zero-credit key is saved with a warning (`:free` models still work), and an unreachable validator saves the key unverified with a warning — the response reports `keySaved`, `keyHint`, `keyValidation`, and `warnings`. Models are checked against the OpenRouter model list — models without `structured_outputs` support are accepted but reported in `warnings` (the router degrades to prompt-only JSON mode); cost cap bounds (0 < cap ≤ 100).

### GET /api/settings/models?q=…
Searchable OpenRouter model list (public endpoint, no key), ranked structured-outputs-first, capped at 50 results: `{ models: [{ id, name?, structuredOutputs }] }`.

### POST /api/settings/validate-key `{ key? }` (falls back to configured key)
- **200** → `{ valid: true, label? }` (label from OpenRouter key info, if present)
- **200** `{ valid: false, reason: "invalid" | "quota" }` — actionable message included.

## Validation (basic claim-to-evidence — Fact Guard foundation)

### POST /api/validation/claims `{ scope: "profile" }`
Deterministic report for the current profile (FR-018 groundwork, profile-level):
- every bullet/entry with `provenance = imported` **must** resolve to an existing SourceDocument + locator (dangling refs are `blocker`s);
- `containmentOk = false` entries are `blocker`s until `user_confirmed`;
- entries missing any provenance marker are `warning`s.
→ `{ report: { flags: [{ code, claim, severity: "blocker"|"warning", affectedFieldIds, sourceEvidence: EvidenceRef[] | null, resolution }], summary: { blockers: n, warnings: n } } }` (flag shape matches the canonical ValidationReport §4; `sourceEvidence` links a flag to the profile entry it concerns — null when the flag is about a *missing* link)
