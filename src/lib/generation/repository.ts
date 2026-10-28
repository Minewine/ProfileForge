import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { findDateOverlapConflict, getOrCreateProfile } from "@/lib/profile/repository";
import {
  ArtifactMetaSchema,
  ValidationReportSchema,
  type ArtifactMeta,
  type ClaimFingerprint,
  type GenerationKind,
  type GenerationSettings,
  type ValidationReport,
} from "@/lib/generation/schemas";

// --- Create (guards per data-model.md) ---

export async function createGenerationJob(userId: string, input: {
  analysisId: string;
  kind: GenerationKind;
  settings: GenerationSettings;
}) {
  const analysis = await db.jobAnalysis.findFirst({ where: { id: input.analysisId, userId } });
  if (!analysis) throw new ApiError("NOT_FOUND", "Analysis not found.");

  if (analysis.status !== "matched" || analysis.matchReport == null) {
    throw new ApiError(
      "ANALYSIS_NOT_MATCHED",
      `Generation requires a matched analysis with a stored match report ` +
        `(current status: "${analysis.status}"). Run the match first.`,
      { status: analysis.status },
    );
  }

  const profile = await getOrCreateProfile(userId);
  const conflict = await findDateOverlapConflict(profile.id);
  if (conflict) {
    throw new ApiError(
      "PROFILE_DATES_CONFLICT",
      "The profile has overlapping experience dates, so a tailored CV cannot be generated. Open the Profile editor and adjust the flagged Start/End dates (each role needs its own period), then generate again.",
      conflict,
    );
  }

  return db.generationJob.create({
    data: {
      analysisId: input.analysisId,
      kind: input.kind,
      settings: input.settings as unknown as object, // frozen at creation
      status: "queued",
      attempt: 1,
      profileVersion: profile.version, // pinned now (research R5)
    },
  });
}

// --- Lifecycle transitions (terminal states immutable; retry is the only way back) ---

function newRunId(jobId: string, attempt: number): string {
  return `gen-${jobId}-a${attempt}-${Date.now()}`;
}

async function loadForTransition(id: string, allowed: string[], action: string) {
  const job = await db.generationJob.findUnique({ where: { id } });
  if (!job) throw new ApiError("NOT_FOUND", "Generation job not found.");
  if (!allowed.includes(job.status)) {
    throw new ApiError(
      "GENERATION_INVALID_STATE",
      `Cannot ${action} a generation job in status "${job.status}" (allowed: ${allowed.join(", ")}).`,
      { status: job.status },
    );
  }
  return job;
}

export async function markRunning(id: string, runId?: string) {
  const job = await loadForTransition(id, ["queued"], "start");
  const effectiveRunId = runId ?? job.runId ?? newRunId(job.id, job.attempt);
  return db.generationJob.update({
    where: { id },
    data: { status: "running", runId: effectiveRunId, startedAt: new Date() },
  });
}

export async function markSucceeded(id: string) {
  await loadForTransition(id, ["running"], "succeed");
  return db.generationJob.update({
    where: { id },
    data: { status: "succeeded", finishedAt: new Date() },
  });
}

export async function markFailed(id: string, statusError: string) {
  await loadForTransition(id, ["running"], "fail");
  return db.generationJob.update({
    where: { id },
    data: { status: "failed", statusError, finishedAt: new Date() },
  });
}

export async function markCancelled(id: string) {
  await loadForTransition(id, ["queued", "running"], "cancel");
  return db.generationJob.update({
    where: { id },
    data: { status: "cancelled", finishedAt: new Date() },
  });
}

export async function setCancelRequested(id: string) {
  await loadForTransition(id, ["queued", "running"], "request cancellation of");
  return db.generationJob.update({ where: { id }, data: { cancelRequested: true } });
}

/** Only `failed`/`cancelled` go back to `queued`, with `attempt + 1` and a fresh runId. */
export async function retryJob(id: string) {
  const job = await loadForTransition(id, ["failed", "cancelled"], "retry");
  const attempt = job.attempt + 1;
  return db.generationJob.update({
    where: { id },
    data: {
      status: "queued",
      attempt,
      runId: newRunId(job.id, attempt), // fresh cost-cap scope per attempt
      statusError: null,
      cancelRequested: false,
      startedAt: null,
      finishedAt: null,
    },
  });
}

// --- Stale-running recovery (research R4) ---

/** Jobs currently executing in THIS process — a `running` row outside this set
 *  was left behind by a dead process and is recovered as INTERRUPTED. Kept on
 *  globalThis (same pattern as db.ts): Next.js instantiates each route bundle's
 *  copy of this module separately, so a plain module-scoped Set is empty in the
 *  polling routes' copies and sweeps live jobs as INTERRUPTED. */
const globalForActiveJobs = globalThis as unknown as { generationActiveJobs?: Set<string> };
const activeJobs: Set<string> = (globalForActiveJobs.generationActiveJobs ??= new Set());

export function registerActiveJob(id: string) {
  activeJobs.add(id);
}

export function unregisterActiveJob(id: string) {
  activeJobs.delete(id);
}

export async function markStaleRunningAsInterrupted(): Promise<number> {
  const active = [...activeJobs];
  const result = await db.generationJob.updateMany({
    where: { status: "running", ...(active.length > 0 ? { id: { notIn: active } } : {}) },
    data: { status: "failed", statusError: "INTERRUPTED", finishedAt: new Date() },
  });
  // A job can also die between create and kickoff (stranded `queued`) or sit
  // queued with a cancel requested that no runner will ever observe — recover
  // both so the UI cannot poll forever (review P2-8).
  const stranded = await db.generationJob.updateMany({
    where: {
      status: "queued",
      OR: [{ cancelRequested: true }, { createdAt: { lt: new Date(Date.now() - 60_000) } }],
      ...(active.length > 0 ? { id: { notIn: active } } : {}),
    },
    data: {
      status: "failed",
      statusError: "INTERRUPTED",
      finishedAt: new Date(),
    },
  });
  return result.count + stranded.count;
}

// --- Reads (each sweeps stale running rows first — research R4 lazy recovery) ---

export async function getJob(userId: string, id: string) {
  await markStaleRunningAsInterrupted();
  const job = await db.generationJob.findFirst({
    where: { id, analysis: { userId } }, // ownership via the job's analysis (data-access-rules.md)
  });
  if (!job) throw new ApiError("NOT_FOUND", "Generation job not found.");
  return job;
}

export async function listByAnalysis(analysisId: string) {
  await markStaleRunningAsInterrupted();
  const rows = await db.generationJob.findMany({
    where: { analysisId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    include: { versions: { select: { version: true } } },
  });
  return rows.map((j) => ({
    generationJobId: j.id,
    kind: j.kind,
    status: j.status,
    attempt: j.attempt,
    version: j.versions[0]?.version ?? null,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    statusError: j.statusError,
  }));
}

// --- Documents & versions ---

export async function ensureDocument(analysisId: string, kind: GenerationKind) {
  const existing = await db.generatedDocument.findUnique({
    where: { analysisId_kind: { analysisId, kind } },
  });
  if (existing) return existing;
  return db.generatedDocument.create({ data: { analysisId, kind } });
}

export async function appendVersion(input: {
  documentId: string;
  producingJobId: string;
  content: unknown;
  validationReport: unknown;
  artifacts?: ArtifactMeta[];
  extractionCheck?: unknown;
  selection?: unknown; // SelectionRecord (feature 005) — persisted as given; absent = null
}) {
  const already = await db.generatedDocumentVersion.findUnique({
    where: { producingJobId: input.producingJobId },
  });
  if (already) {
    throw new ApiError(
      "GENERATION_INVALID_STATE",
      "This generation job already produced a document version (one version per successful job).",
    );
  }
  return db.$transaction(async (tx) => {
    const latest = await tx.generatedDocumentVersion.findFirst({
      where: { documentId: input.documentId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return tx.generatedDocumentVersion.create({
      data: {
        documentId: input.documentId,
        version: (latest?.version ?? 0) + 1,
        producingJobId: input.producingJobId,
        content: input.content as object,
        validationReport: input.validationReport as object,
        selection: (input.selection ?? Prisma.DbNull) as object, // feature 005 — absent/null = DB NULL
        ...(input.artifacts ? { artifacts: input.artifacts as object[] } : {}),
        ...(input.extractionCheck !== undefined
          ? { extractionCheck: input.extractionCheck as object }
          : {}),
      },
    });
  });
}

export async function getCurrentVersion(documentId: string) {
  return db.generatedDocumentVersion.findFirst({
    where: { documentId },
    orderBy: { version: "desc" },
  });
}

/**
 * Job-scoped version resolution (review P1-2): a job reads ITS OWN version —
 * so a later regeneration that failed the extraction gate can never hijack the
 * reads of an earlier still-succeeded job (its verified PDF stays downloadable
 * and its claim review stays intact). Falls back to the document's latest
 * version for jobs that have not produced one yet (e.g. legacy rows).
 */
export async function getVersionForJob(jobId: string, documentId: string) {
  const own = await db.generatedDocumentVersion.findUnique({ where: { producingJobId: jobId } });
  if (own) return own;
  return getCurrentVersion(documentId);
}

/**
 * Latest version produced by a SUCCEEDED job — the deliverable state. Used
 * where cross-job readers (restored omissions, the letter's anti-repetition
 * input) must never pick up a gate-failed attempt's content.
 */
export async function getLatestSuccessfulVersion(documentId: string) {
  return db.generatedDocumentVersion.findFirst({
    where: { documentId, producingJob: { status: "succeeded" } },
    orderBy: { version: "desc" },
  });
}

/** Pipeline variant of `appendVersion`: a retry of a job whose earlier attempt
 *  already appended its (gate-failed, artifact-less) version refreshes that row
 *  in place — "one version per job" holds across attempts too, and a retried
 *  export can succeed without a producingJobId clash. */
export async function upsertJobVersion(input: {
  documentId: string;
  producingJobId: string;
  content: unknown;
  validationReport: unknown;
  artifacts?: ArtifactMeta[];
  extractionCheck?: unknown;
  selection?: unknown; // SelectionRecord (feature 005) — persisted as given; absent = null
}) {
  const already = await db.generatedDocumentVersion.findUnique({
    where: { producingJobId: input.producingJobId },
  });
  if (already) {
    return db.generatedDocumentVersion.update({
      where: { id: already.id },
      data: {
        content: input.content as object,
        validationReport: input.validationReport as object,
        selection: (input.selection ?? Prisma.DbNull) as object, // feature 005 — absent/null = DB NULL
        ...(input.artifacts ? { artifacts: input.artifacts as object[] } : {}),
        ...(input.extractionCheck !== undefined
          ? { extractionCheck: input.extractionCheck as object }
          : {}),
      },
    });
  }
  return appendVersion(input);
}

/** Claim resolution edits: rewrite content/validationReport, bump revision. */
export async function updateVersionContent(
  versionId: string,
  patch: { content?: unknown; validationReport?: unknown },
) {
  const existing = await db.generatedDocumentVersion.findUnique({ where: { id: versionId } });
  if (!existing) throw new ApiError("NOT_FOUND", "Document version not found.");
  return db.generatedDocumentVersion.update({
    where: { id: versionId },
    data: {
      revision: { increment: 1 },
      ...(patch.content !== undefined ? { content: patch.content as object } : {}),
      ...(patch.validationReport !== undefined
        ? { validationReport: patch.validationReport as object }
        : {}),
    },
  });
}

/** Confirmations rewrite only the report — no revision bump (data-model:
 *  confirm sets resolution, nothing else). */
export async function setVersionValidationReport(versionId: string, validationReport: unknown) {
  const existing = await db.generatedDocumentVersion.findUnique({ where: { id: versionId } });
  if (!existing) throw new ApiError("NOT_FOUND", "Document version not found.");
  return db.generatedDocumentVersion.update({
    where: { id: versionId },
    data: { validationReport: validationReport as object },
  });
}

/** Export-stage persistence (US3): the version is appended first (content is
 *  final after fitting — its id drives the artifact path), then the written
 *  artifacts metadata + extraction-check result land on it. */
export async function setVersionArtifacts(
  versionId: string,
  patch: { artifacts: ArtifactMeta[]; extractionCheck?: unknown },
) {
  const existing = await db.generatedDocumentVersion.findUnique({ where: { id: versionId } });
  if (!existing) throw new ApiError("NOT_FOUND", "Document version not found.");
  return db.generatedDocumentVersion.update({
    where: { id: versionId },
    data: {
      artifacts: patch.artifacts as object[],
      ...(patch.extractionCheck !== undefined ? { extractionCheck: patch.extractionCheck as object } : {}),
    },
  });
}

// --- Confirmation fingerprints (carried across versions, R10) ---

export async function recordConfirmation(documentId: string, entry: ClaimFingerprint) {
  const document = await db.generatedDocument.findUnique({ where: { id: documentId } });
  if (!document) throw new ApiError("NOT_FOUND", "Generated document not found.");
  const current = parseFingerprints(document.confirmations);
  if (current.some((f) => f.fingerprint === entry.fingerprint)) return current; // idempotent
  const next = [...current, entry];
  await db.generatedDocument.update({
    where: { id: documentId },
    data: { confirmations: next as unknown as object[] },
  });
  return next;
}

export async function findConfirmedFingerprints(documentId: string): Promise<ClaimFingerprint[]> {
  const document = await db.generatedDocument.findUnique({ where: { id: documentId } });
  if (!document) return [];
  return parseFingerprints(document.confirmations);
}

function parseFingerprints(value: unknown): ClaimFingerprint[] {
  const parsed = z.array(z.object({ fingerprint: z.string(), confirmedAt: z.string() })).safeParse(value);
  return parsed.success ? parsed.data : [];
}

// --- Usage aggregation (per runId) ---

export type RunUsage = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};

export async function getRunUsage(runId: string): Promise<RunUsage> {
  const rows = await db.llmUsageLog.findMany({ where: { runId } });
  return rows.reduce<RunUsage>(
    (acc, r) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + r.promptTokens,
      completionTokens: acc.completionTokens + r.completionTokens,
      costUsd: Math.round((acc.costUsd + r.costUsd) * 1e6) / 1e6,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
  );
}

// --- Document summary for the polling GET (live gate matrix) ---

export type DocumentVersionView = {
  version: number;
  revision: number;
  content: unknown; // GeneratedCVContent | CoverLetterContent (kind-dependent)
  validationReport: ValidationReport | null;
  /** SelectionRecord (feature 005) — which entries were selected and why; null for pre-feature versions. */
  selection: unknown;
  /** Full two-level gate result once the export stage has run (US3). */
  extractionCheck?: unknown;
};

export type DocumentSummary = {
  documentId: string;
  currentVersion: number | null;
  downloadable: { pdf: boolean; docx: boolean; txt: boolean };
  summary: { blockers: number; warnings: number };
  /** Current version payload (content + report) for the UI provenance drill-down. */
  version: DocumentVersionView | null;
};

export async function getDocumentSummary(
  documentId: string,
  opts: { forJobId?: string } = {},
): Promise<DocumentSummary | null> {
  const document = await db.generatedDocument.findUnique({ where: { id: documentId } });
  if (!document) return null;
  const version = opts.forJobId
    ? await getVersionForJob(opts.forJobId, documentId)
    : await getCurrentVersion(documentId);
  return {
    documentId: document.id,
    currentVersion: version?.version ?? null,
    downloadable: computeDownloadable(version),
    summary: reportSummary(version),
    version: version
      ? {
          version: version.version,
          revision: version.revision,
          content: version.content,
          validationReport: parseReport(version),
          selection: version.selection ?? null,
          ...(version.extractionCheck ? { extractionCheck: version.extractionCheck } : {}),
        }
      : null,
  };
}

/** Polling-GET helper: resolve the document by its (analysisId, kind) identity. */
export async function getDocumentSummaryFor(
  analysisId: string,
  kind: GenerationKind,
  opts: { forJobId?: string } = {},
): Promise<DocumentSummary | null> {
  const document = await db.generatedDocument.findUnique({
    where: { analysisId_kind: { analysisId, kind } },
  });
  if (!document) return null;
  return getDocumentSummary(document.id, opts);
}

function parseReport(version: { validationReport: unknown } | null): ValidationReport | null {
  if (!version) return null;
  const parsed = ValidationReportSchema.safeParse(version.validationReport);
  return parsed.success ? parsed.data : null;
}

function reportSummary(version: { validationReport: unknown } | null): {
  blockers: number;
  warnings: number;
} {
  return parseReport(version)?.summary ?? { blockers: 0, warnings: 0 };
}

/** Live download-gate matrix (data-model.md): no pending blockers, semantic layer
 *  run (fail-closed, FR-010), artifact present — and pdf additionally gate-verified.
 *  Exported for the document/download routes. */
export function computeDownloadable(version: {
  validationReport: unknown;
  artifacts: unknown;
  extractionCheck: unknown;
} | null): { pdf: boolean; docx: boolean; txt: boolean } {
  const closed = { pdf: false, docx: false, txt: false };
  if (!version) return closed;
  const report = ValidationReportSchema.safeParse(version.validationReport);
  if (!report.success) return closed;
  if (!report.data.layersRun.semantic) return closed;
  if (report.data.flags.some((f) => f.severity === "blocker" && f.resolution === "pending")) {
    return closed;
  }
  const artifacts = z.array(ArtifactMetaSchema).catch([]).parse(version.artifacts ?? []);
  const has = (format: ArtifactMeta["format"]) => artifacts.some((a) => a.format === format);
  const extraction = version.extractionCheck as { passed?: boolean } | null;
  return {
    pdf: has("pdf") && extraction?.passed === true,
    docx: has("docx"),
    txt: has("txt"),
  };
}
