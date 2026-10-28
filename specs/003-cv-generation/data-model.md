# Data Model — Slice 3: Evidence-Aware CV & Cover Letter Generation

Canonical authority: `ProfileForge-Specification.md` §4 (`GeneratedCVContent`, `ValidationReport`) and `specs/003-cv-generation/spec.md`. New Prisma models follow the slice-2 JSONB-persistence pattern (research R6). Existing models referenced: `Profile`/`ProfileSnapshot`, `JobAnalysis`, `AppSettings`, `LlmUsageLog`.

## Entity Overview

```text
JobAnalysis (existing, status=matched)
   │ 1
   ├────────────────< GenerationJob >────────────────┐  (executions; retry bumps attempt)
   │                        │ produces 1             │
   │                        ▼                        │
   └────────────────< GeneratedDocument ──┐          │
                        @@unique([analysisId, kind]) │
                          │ 1..*                     │
                          ▼                          │
                   GeneratedDocumentVersion ─────────┘ (producingJobId)
                          │ artifacts (files on disk, metadata in JSONB)
                          ▼
              UPLOADS_DIR/generations/{versionId}/*.{pdf,docx,txt}

ProfileSnapshot (existing)  ← pinned read at job start (GenerationJob.profileVersion)
```

## GenerationJob

| Field | Type | Rules |
|---|---|---|
| id | String | cuid PK |
| analysisId | String | FK → JobAnalysis, cascade delete |
| kind | String | `"cv"` \| `"cover_letter"` |
| settings | Json | `GenerationSettings` (below); frozen at creation |
| status | String | `queued` → `running` → `succeeded` \| `failed` \| `cancelled`; terminal states immutable except `failed`/`cancelled` → `queued` via retry |
| statusError | String? | Machine code + human message on failure (taxonomy in `contracts/api.md`) |
| cancelRequested | Boolean | default false; checked between pipeline stages and before each LLM call |
| attempt | Int | default 1; incremented on retry |
| runId | String? | Cost-cap grouping per attempt (fresh on retry); usage visible per run |
| profileVersion | Int | Pinned at job creation = `profile.version` at start (research R5) |
| notice | String? | e.g. `stale-analysis` when MatchReport evidence refs dangled against the pinned snapshot |
| startedAt / finishedAt | DateTime? | Lifecycle timestamps |

Guards: creatable only when the analysis `status = "matched"` with a stored `matchReport`; the profile's overlapping-dates warning (existing `src/lib/profile/repository.ts` overlap check) must be resolved first → else `PROFILE_DATES_CONFLICT`.

## GeneratedDocument

| Field | Type | Rules |
|---|---|---|
| id | String | cuid PK |
| analysisId | String | FK → JobAnalysis, cascade delete |
| kind | String | `"cv"` \| `"cover_letter"`; `@@unique([analysisId, kind])` |
| confirmations | Json | `ClaimFingerprint[]` (below) — grows as users confirm; pruned never |

## GeneratedDocumentVersion

| Field | Type | Rules |
|---|---|---|
| id | String | cuid PK |
| documentId | String | FK → GeneratedDocument, cascade delete |
| version | Int | 1-based per document; `@@unique([documentId, version])` |
| producingJobId | String | FK → GenerationJob, unique (one version per successful job) |
| content | Json | `GeneratedCVContent` \| `CoverLetterContent` (below) — includes omissions + provenance |
| validationReport | Json | `ValidationReport` (below); rewritten on claim edits (revision counter tracks it) |
| revision | Int | default 0; incremented on each claim edit/remove (confirm does not bump — it only sets resolution) |
| artifacts | Json | `ArtifactMeta[]` (below) |
| extractionCheck | Json? | Full two-level gate result for the PDF (per-element + per-block detail) |

Immutability: content and validationReport change **only** through claim resolution (PATCH/DELETE/confirm); regeneration always creates a new version (FR-018).

## Stored JSONB shapes

```ts
// settings — frozen at job creation
type GenerationSettings = {
  outputLanguage: "fr" | "en";      // default: analysis.language (JD's detected language)
  pageBudget: number;               // 1..3, default 2 (cv); cover_letter fixed at 1
  tone?: "professional" | "enthusiastic" | "formal";  // letter only, default "professional"
  notes?: string;                   // free-text, ≤ 2000 chars
};

// content (cv) — canonical GeneratedCVContent (spec §4), extended with stable claim ids
type GeneratedCVContent = {
  claimIdVersion: 1;                // namespace for stable claim ids
  summary: string;
  summaryProvenance: EvidenceRef[];          // reused from src/lib/jobs/schemas.ts
  experience: {
    id: string;                              // pinned-snapshot experience id
    bullets: { claimId: string; text: string; sourceBulletIds: string[]; rationale?: string }[];
  }[];
  education:  { id: string; claimId: string; text: string; sourceIds: string[] }[];   // similarly structured
  projects:   { id: string; bullets: { claimId: string; text: string; sourceBulletIds: string[] }[] }[];
  certifications: { id: string; claimId: string; text: string; sourceIds: string[] }[];
  skills: string[];                          // deterministic from MatchReport (R7)
  omissions: Omission[];
};
type Omission = { type: string; id: string; reason: string; restoredMustInclude?: boolean };

// content (cover_letter)
type CoverLetterContent = {
  claimIdVersion: 1;
  paragraphs: { claimId: string; text: string; evidence: EvidenceRef[] }[];
  tone: string;
  omissions: Omission[];                     // expectedly empty for letters
};

// validation report — canonical ValidationReport (spec §4)
type ValidationReport = {
  layersRun: { deterministic: true; semantic: boolean };   // semantic=false ⇒ fail-closed gate
  flags: {
    code: string;                            // see contracts/generation-pipeline.md §Fact Guard
    claim: string;                           // claimId addressed
    severity: "blocker" | "warning";
    affectedFieldIds?: string[];
    sourceEvidence?: EvidenceRef[];
    resolution: "pending" | "user_confirmed" | "edited" | "removed";
    confirmedAt?: string;                    // attribution when user_confirmed
  }[];
  summary: { blockers: number; warnings: number };
};

// artifact metadata
type ArtifactMeta = {
  format: "pdf" | "docx" | "txt";
  storagePath: string; sha256: string; bytes: number;
  gate: "verified" | "best_effort" | "none"; // pdf=verified after passing; docx=best_effort; txt=none
};

// cross-version confirmation identity (R10)
type ClaimFingerprint = { fingerprint: string; confirmedAt: string };
```

## State machines

**GenerationJob.status**: `queued → running → succeeded` | `running → failed` (statusError set; retryable) | `queued|running → cancelled` (via cancelRequested). Recovery: any `running` row observed after a process restart is transitioned to `failed` with `statusError = "INTERRUPTED"` (retryable). `succeeded` is terminal; regeneration creates a new job/version.

**Validation flag resolution**: `pending → user_confirmed` (POST confirm) | `edited` (PATCH text; the flag is re-evaluated — passing flags clear, failing flags stay pending) | `removed` (DELETE block). Download gate = no flag with `severity: "blocker"` and `resolution: "pending"`, and (PDF only) `extractionCheck.passed = true`, and `layersRun.semantic = true`.

**Omission state**: omitted (in `content.omissions`) → restored (`restoredMustInclude: true`, applies at next regeneration) → consumed (present in the new version's content, absent from omissions) — or `PAGE_BUDGET_CONFLICT` job failure (R9).

## Validation rules (cross-cutting)

- Every `sourceBulletIds`/`EvidenceRef.id` in content MUST resolve against the pinned `ProfileSnapshot` at `profileVersion` — enforced by the Fact Guard deterministic layer (`DANGLING_PROVENANCE`).
- Every number, year, percentage, and duration token in a claim MUST appear in its cited evidence (normalized) — `NUMERIC_MISMATCH`.
- `skills[]` entries MUST be profile skills or exact/approved-alias matches — `SKILL_UNVERIFIED`.
- `outputLanguage` MUST equal the language of all rendered narrative/headings; proper nouns stay verbatim (LLM prompt constraint + spot-check by semantic layer).
- Claim ids are stable within a version: `summary`, `exp.{experienceId}.{n}`, `proj.{projectId}.{n}`, `edu.{educationId}`, `cert.{certificationId}`, `letter.{n}`.
- `settings.pageBudget` ∈ 1..3 for cv; letter fixed at 1. `notes` ≤ 2000 chars.
- Confirmation fingerprints: `sha256(normalizeText(claimText) + "|" + sorted(evidenceIds).join(","))`.

## Deferred (later slices — do not model)

- Evaluation benchmark persistence and pass/fail history (Slice 4).
- Live rendered-document preview and Gap Bridge UI (Slice 4).
- Additional templates / template registry (post-MVP).
- Any multi-user/tenant scoping (hosted decision, later).
