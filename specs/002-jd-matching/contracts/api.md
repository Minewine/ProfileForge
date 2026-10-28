# API Contract: Slice 2 (Jobs / Analyses)

Same error envelope and code taxonomy as Slice 1 (`{ error: { code, message, details? } }`); new codes: `JD_TOO_SHORT`, `JD_TOO_LONG`, `INVALID_STATE` (action not allowed for the analysis's status). All bodies zod-validated.

Module mapping: `analyzeJob(jdText, profile) → MatchReport` (source doc §3) = create → extract → requirements(PUT) → match chained below.

## Create & list

### POST /api/jobs  `{ text: string }`
Fast path (<1 s, no LLM): validate length (200..100,000), detect language (franc), persist.
- **201** → `{ analysisId, language, languageLowConfidence, status: "created" }`
- **400** `JD_TOO_SHORT` / `JD_TOO_LONG` with guidance (never silent truncation).

### GET /api/jobs
- **200** → `{ analyses: [{ id, status, language, createdAt, overallScore?, requirementCount, rerunOfId?, title }] }` (title = first 60 chars of jdText; score chip data).

## Single analysis

### GET /api/jobs/{id}
- **200** → `{ analysis: { id, language, languageManuallyCorrected, status, notice?, profileVersion?, semanticDropped, jdText, requirements: JobRequirement[], matchReport? } }`

### PATCH /api/jobs/{id}  `{ language: "fr" | "en" }`
Allowed while status ≠ `matched`. Updates language + correction flag; re-extraction uses it.

### DELETE /api/jobs/{id}
**204**; cascades requirements. (Also the parent FR-024 deletion guarantee.)

## Extraction (LLM)

### POST /api/jobs/{id}/extract
Allowed in `created | extracted | failed(after extract)`. Runs the `extractRequirements` task (economy tier, own runId under the cost cap). Re-extraction **replaces** the requirement list (user edits are lost — stated in the response as `replacedRequirements: true`).
- **200** → `{ status: "extracted", requirements: JobRequirement[], usage }`
- **LLM errors** per taxonomy; analysis → `failed` with `statusError`, retryable.

## Requirement review (authoritative list)

### PUT /api/jobs/{id}/requirements  `{ requirements: [{ text, category, importance, isHardConstraint }], finalize: boolean }`
Allowed in `extracted | finalized`. Full-list replace (the client's reviewed list is the truth — FR-003). `finalize: true` transitions `extracted → finalized`. Existing `userConfirmed` flags on hard constraints are preserved by text+category match during replace; confirmed rows copied on re-run.
- **200** → `{ status, requirements: JobRequirement[] }`

## Match (deterministic engine + semantic)

### POST /api/jobs/{id}/match
Allowed in `finalized` (or `matched` to recompute in place from the same requirements — see note). One run: deterministic exact/alias over a pinned profile snapshot → `semanticProposals` LLM task (non-hard requirements only, same runId) → evidence validation → statuses/credits → score → persist (pins current profile version).
- **200** → `{ status: "matched", report: MatchReport, profileVersion, usage, semanticDropped }`
- Semantic-task failure → **200 with degraded report**: exact/alias layers only, `notice: "semantic-matching-unavailable"`, `semanticMatches: 0` (FR-014) — never blocks, never fabricates.
- Deterministic-layer or persistence failure → analysis `failed`, taxonomy error.

Note: calling match on an already-`matched` analysis re-pins the current profile version and **replaces the stored report** only when the caller passes `{ recompute: true }` explicitly; default on `matched` is `409 INVALID_STATE` nudging to `/rerun` (history preservation, FR-011).

## User confirmation (hard constraints)

### POST /api/jobs/{id}/confirm  `{ requirementId }`
Marks a hard-constraint requirement as user-confirmed (FR-007): the stored report's entry flips to `matchMethod: "semantic", status: "strong", userConfirmed: true` **only if** the engine had recorded a semantic proposal for it (dropped or not) — confirmation is evidence-gated, not a free pass; otherwise `400 VALIDATION_ERROR`. Score is recomputed and persisted (same analysis version; the confirmation is attributable and persists across re-runs via requirement copy).
- **200** → `{ report: MatchReport }`

## Re-run

### POST /api/jobs/{id}/rerun
Allowed on `matched` analyses. Creates a **new** analysis: copies jdText, corrected language, and the finalized requirement list (with confirmations); status starts `finalized`; `rerunOfId` links back. Immediately runnable through `/match` against the current profile version.
- **201** → `{ analysisId }` (client redirects to the new analysis)
