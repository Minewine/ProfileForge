# API Contract — Generation Jobs, Documents, Downloads

All routes extend the existing surface under `/api` and share the established response envelope: errors as `{ error: { code, message, details? } }` (`src/lib/api/errors.ts`); success bodies as plain JSON. Handlers are plain exported functions (directly unit-invocable in tests).

**New error codes** (added to `ERROR_CODES`): `ANALYSIS_NOT_MATCHED`, `GENERATION_INVALID_STATE`, `PAGE_BUDGET_CONFLICT`, `FACTGUARD_UNAVAILABLE`, `BLOCKERS_UNRESOLVED`, `EXPORT_GATE_FAILED`, `CLAIM_NOT_FOUND`, `OMISSION_NOT_FOUND`, `PROFILE_DATES_CONFLICT`, `INTERRUPTED`. Existing codes reused: `LLM_*` taxonomy, `COST_CAP_REACHED`, `INVALID_STATE`.

## Generation jobs

### POST /api/generations {analysisId, kind, settings?}

- Body: `analysisId` (existing matched analysis), `kind: "cv" | "cover_letter"`, optional `settings {outputLanguage?, pageBudget?, tone?, notes?}` (defaults per data model; `outputLanguage` defaults to the analysis's detected JD language).
- Guards: analysis exists and `status = "matched"` with stored `matchReport` (else **409** `ANALYSIS_NOT_MATCHED`); profile has no unresolved overlapping-dates conflict (else **409** `PROFILE_DATES_CONFLICT`); `settings` valid (else **400**).
- Creates the job `queued`, pins `profileVersion = profile.version` now, restores prior-version `restoredMustInclude` omissions into the plan inputs, starts the pipeline without awaiting, returns **202** `{generationJobId, status: "queued", documentId, settings}`.
- A new job for an existing `(analysisId, kind)` document is a regeneration: on success it appends the next version.

### GET /api/generations?analysisId={id}

- **200** `{generations: [{generationJobId, kind, status, attempt, version?, createdAt, finishedAt, statusError?}]}` — polling-friendly list for the analysis page.

### GET /api/generations/[id]

- **200** `{job: {id, kind, status, statusError?, attempt, runId?, profileVersion, notice?, settings}, document: {documentId, currentVersion, downloadable: {pdf, docx, txt}, summary: {blockers, warnings}} | null, usage?}`.
- **404** if unknown. This is the polling endpoint; `downloadable` recomputes the gate matrix live.

### POST /api/generations/[id]/cancel

- Allowed from `queued`/`running` (else **409** `GENERATION_INVALID_STATE`); sets `cancelRequested`. **200** `{status}` (may still report `running` — cancellation lands at the next stage boundary; final state is `cancelled`).

### POST /api/generations/[id]/retry

- Allowed from `failed`/`cancelled` (else **409**); increments `attempt`, fresh `runId`, back to `queued`. **202** `{generationJobId, attempt}`.

## Document & claim resolution

### GET /api/generations/[id]/document

- **200** full current version: `{version, revision, content, validationReport, omissions (from content), extractionCheck?, artifacts, canDownload: {pdf, docx, txt}, notice?}` — the claim-review UI's data source. **404** if the job has no version yet (`GENERATION_INVALID_STATE` **409** when the job hasn't succeeded).

### PATCH /api/generations/[id]/document/claims {claimId, text}

- Edits a claim's text on the current version (structured content, never the rendered artifact). Triggers both Fact Guard layers on the version; rewrites `validationReport`; bumps `revision`. **200** `{validationReport}`.
- **404** `CLAIM_NOT_FOUND`; **409** `FACTGUARD_UNAVAILABLE` if the semantic layer is down — the edit is stored with resolution `edited`, deterministic flags are refreshed, and download stays blocked.

### DELETE /api/generations/[id]/document/claims {claimId}

- Removes the claim block from content; flag resolution `removed`; re-validate + bump revision. **200** `{validationReport}`. **404** `CLAIM_NOT_FOUND`.

### POST /api/generations/[id]/document/claims/[claimId]/confirm

- Records `user_confirmed` with `confirmedAt` (attribution); stores the fingerprint on the document (carries to future versions with unchanged claims). **200** `{validationReport}`. **404** `CLAIM_NOT_FOUND`.

### POST /api/generations/[id]/document/omissions/[omissionId]/restore

- Marks the omission `restoredMustInclude: true` on the current version (applies at the next regeneration; a `PAGE_BUDGET_CONFLICT` failure there is the explicit conflict path). **200** `{omissions}`. **404** `OMISSION_NOT_FOUND`.

## Downloads

### GET /api/generations/[id]/download?format=pdf|docx|txt

- Gate order: job `succeeded` with a version (else **409** `GENERATION_INVALID_STATE`); no pending blockers (else **403** `BLOCKERS_UNRESOLVED` + current flag summary in details); format constraints: `pdf` requires `extractionCheck.passed` (artifacts are only written after passing — a failed-gate version has no PDF to serve and reports **409** `EXPORT_GATE_FAILED` with check results); `docx`/`txt` best-effort/ungated by extraction (parent exception).
- **200** streams the file with `Content-Disposition: attachment; filename="{kind}-v{version}.{ext}"`.
