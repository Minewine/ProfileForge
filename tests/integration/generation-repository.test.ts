import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { createAnalysis, persistReport } from "@/lib/jobs/repository";
import { getOrCreateProfile } from "@/lib/profile/repository";
import type { MatchReport } from "@/lib/jobs/schemas";
import {
  appendVersion,
  createGenerationJob,
  ensureDocument,
  getCurrentVersion,
  getDocumentSummary,
  getJob,
  getLatestSuccessfulVersion,
  getRunUsage,
  getVersionForJob,
  listByAnalysis,
  markCancelled,
  markFailed,
  markRunning,
  markSucceeded,
  retryJob,
  setCancelRequested,
  updateVersionContent,
  upsertJobVersion,
} from "@/lib/generation/repository";
import { resolveGenerationSettings, type GenerationSettings } from "@/lib/generation/schemas";
import { resetAuth, signIn, type SessionUser } from "../support/auth";

const JD = `Senior Backend Engineer. We require strong experience in distributed systems.
You must have Kubernetes and Go. A degree in Computer Science is required.
Nice to have: Kafka experience. French is a plus.`;

function reportFixture(overrides: Partial<MatchReport> = {}): MatchReport {
  return {
    overallScore: 50,
    scoreBreakdown: {
      hardRequirementsMet: 1,
      preferredRequirementsMet: 0,
      exactMatches: 1,
      aliasMatches: 0,
      semanticMatches: 0,
      hardWeight: 60,
      preferredWeight: 30,
      evidenceBonus: 0,
    },
    requirements: [],
    recommendedKeywords: [],
    missingKeywords: [],
    semanticDropped: 0,
    ...overrides,
  };
}

const cleanReport = {
  flags: [],
  summary: { blockers: 0, warnings: 0 },
};

async function clean() {
  await db.generatedDocumentVersion.deleteMany({});
  await db.generatedDocument.deleteMany({});
  await db.generationJob.deleteMany({});
  await db.jobRequirement.deleteMany({});
  await db.jobAnalysis.deleteMany({});
  await db.profileSnapshot.deleteMany({});
  await db.bullet.deleteMany({});
  await db.experience.deleteMany({});
  await db.education.deleteMany({});
  await db.skill.deleteMany({});
  await db.languageSkill.deleteMany({});
  await db.project.deleteMany({});
  await db.certification.deleteMany({});
  await db.profile.deleteMany({});
  await db.sourceDocument.deleteMany({});
  await db.llmUsageLog.deleteMany({});
}

async function matchedAnalysisId(): Promise<string> {
  const { analysis } = await createAnalysis(user.id, JD);
  await persistReport(user.id, analysis.id, 1, reportFixture());
  return analysis.id;
}

function cvSettings(): GenerationSettings {
  return resolveGenerationSettings({ kind: "cv", analysisLanguage: "en" });
}

async function addExperience(profileId: string, company: string, startDate: string, endDate: string) {
  return db.experience.create({
    data: { profileId, company, title: "Engineer", startDate, endDate },
  });
}

beforeEach(async () => {
  await resetAuth();
  user = await signIn("gen-repo@example.com");
  await clean();
});

// Signed-in identity for the suite (multi-user isolation, feature 008) — every
// repository call and JobAnalysis fixture is scoped to this user.
let user: SessionUser;

describe("createGenerationJob guards", () => {
  it("refuses ANALYSIS_NOT_MATCHED unless matched with a stored report", async () => {
    const { analysis } = await createAnalysis(user.id, JD); // status "created"
    await expect(
      createGenerationJob(user.id, { analysisId: analysis.id, kind: "cv", settings: cvSettings() }),
    ).rejects.toMatchObject({ code: "ANALYSIS_NOT_MATCHED" });

    // forced "matched" without a stored report still refuses
    await db.jobAnalysis.update({
      where: { id: analysis.id },
      data: { status: "matched", matchReport: Prisma.DbNull },
    });
    await expect(
      createGenerationJob(user.id, { analysisId: analysis.id, kind: "cv", settings: cvSettings() }),
    ).rejects.toMatchObject({ code: "ANALYSIS_NOT_MATCHED" });

    await expect(
      createGenerationJob(user.id, { analysisId: "missing", kind: "cv", settings: cvSettings() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates a job despite overlapping experience dates (no blocking guard)", async () => {
    const analysisId = await matchedAnalysisId();
    const profile = await getOrCreateProfile(user.id);
    await addExperience(profile.id, "A", "2020-01", "2021-01");
    await addExperience(profile.id, "B", "2020-06", "2022-01"); // overlaps A

    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    expect(job.status).toBe("queued");
  });

  it("pins profileVersion = profile.version at creation", async () => {
    const analysisId = await matchedAnalysisId();
    const profile = await getOrCreateProfile(user.id);
    // bump the version the way profile mutations do
    await db.profile.update({ where: { id: profile.id }, data: { version: 7 } });

    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    expect(job.profileVersion).toBe(7);
    expect(job.attempt).toBe(1);
    expect(job.runId).toBeNull();
    expect(job.settings).toMatchObject({ outputLanguage: "en", pageBudget: 2 });
  });
});

describe("job lifecycle", () => {
  it("walks queued → running → succeeded and enforces terminal immutability", async () => {
    const analysisId = await matchedAnalysisId();
    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });

    const running = await markRunning(job.id, "run-1");
    expect(running.status).toBe("running");
    expect(running.runId).toBe("run-1");
    expect(running.startedAt).not.toBeNull();

    const done = await markSucceeded(job.id);
    expect(done.status).toBe("succeeded");
    expect(done.finishedAt).not.toBeNull();

    // terminal states are immutable
    await expect(markFailed(job.id, "LATE: too late")).rejects.toMatchObject({
      code: "GENERATION_INVALID_STATE",
    });
    await expect(markCancelled(job.id)).rejects.toMatchObject({ code: "GENERATION_INVALID_STATE" });
    await expect(markRunning(job.id, "run-2")).rejects.toMatchObject({
      code: "GENERATION_INVALID_STATE",
    });
    await expect(setCancelRequested(job.id)).rejects.toMatchObject({
      code: "GENERATION_INVALID_STATE",
    });
    await expect(retryJob(job.id)).rejects.toMatchObject({ code: "GENERATION_INVALID_STATE" });
    expect((await getJob(user.id, job.id)).statusError).toBeNull(); // untouched by refused transitions
  });

  it("fails with statusError and retries with attempt+1 and a fresh runId", async () => {
    const analysisId = await matchedAnalysisId();
    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    await markRunning(job.id, "run-1");
    // provider error text can carry a literal NUL byte — Postgres rejects 0x00
    // in text columns, so markFailed must strip it instead of crashing
    const failed = await markFailed(job.id, "LLM_UNAVAILABLE: provider\0down");
    expect(failed.status).toBe("failed");
    expect(failed.statusError).toBe("LLM_UNAVAILABLE: providerdown");

    const retried = await retryJob(job.id);
    expect(retried.status).toBe("queued");
    expect(retried.attempt).toBe(2);
    expect(retried.runId).not.toBeNull();
    expect(retried.runId).not.toBe("run-1");
    expect(retried.statusError).toBeNull();
    expect(retried.cancelRequested).toBe(false);

    // queued → running picks up the retry runId unless overridden
    const running = await markRunning(job.id);
    expect(running.runId).toBe(retried.runId);

    // retry only from failed/cancelled
    await markSucceeded(job.id);
    await expect(retryJob(job.id)).rejects.toMatchObject({ code: "GENERATION_INVALID_STATE" });
  });

  it("sets cancelRequested from queued/running only", async () => {
    const analysisId = await matchedAnalysisId();
    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    const flagged = await setCancelRequested(job.id);
    expect(flagged.cancelRequested).toBe(true);
    expect(flagged.status).toBe("queued");

    const cancelled = await markCancelled(job.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(setCancelRequested(job.id)).rejects.toMatchObject({
      code: "GENERATION_INVALID_STATE",
    });

    // cancelled is retryable
    const retried = await retryJob(job.id);
    expect(retried.status).toBe("queued");
    expect(retried.attempt).toBe(2);
  });

  it("lists by analysis with produced version, and 404s unknown ids", async () => {
    const analysisId = await matchedAnalysisId();
    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    const other = await createGenerationJob(user.id, {
      analysisId,
      kind: "cover_letter",
      settings: resolveGenerationSettings({ kind: "cover_letter", analysisLanguage: "en" }),
    });

    let listed = await listByAnalysis(analysisId);
    expect(listed).toHaveLength(2);
    expect(listed.map((j) => j.kind).sort()).toEqual(["cover_letter", "cv"]);
    expect(listed[0]).toMatchObject({
      generationJobId: other.id,
      status: "queued",
      attempt: 1,
      version: null,
      statusError: null,
    });
    expect(typeof listed[0].createdAt).toBe("string");

    // a produced version surfaces in the list
    const document = await ensureDocument(analysisId, "cv");
    await appendVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1 },
      validationReport: cleanReport,
    });
    listed = await listByAnalysis(analysisId);
    const cvRow = listed.find((j) => j.generationJobId === job.id)!;
    expect(cvRow.version).toBe(1);
    expect(cvRow.finishedAt).toBeNull();

    await expect(getJob(user.id, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("recovers stale running rows as failed INTERRUPTED on list/read", async () => {
    const analysisId = await matchedAnalysisId();
    const stale = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    const fresh = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    // simulate rows left running by a dead process (never registered active)
    await db.generationJob.updateMany({ where: { id: { in: [stale.id, fresh.id] } }, data: { status: "running" } });

    await getJob(user.id, stale.id); // any read sweeps stale running rows
    const swept = await db.generationJob.findUnique({ where: { id: fresh.id } });
    expect(swept?.status).toBe("failed");
    expect(swept?.statusError).toBe("INTERRUPTED");
    expect(swept?.finishedAt).not.toBeNull();
    expect((await getJob(user.id, stale.id)).status).toBe("failed");
  });

  it("shares the active-job set across module instances (per-route bundles)", async () => {
    const analysisId = await matchedAnalysisId();
    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    await db.generationJob.update({ where: { id: job.id }, data: { status: "running" } });

    // Next.js gives each route bundle its own copy of the module: a registration
    // made through a fresh instance must still protect the job from THIS
    // instance's sweep (this was the false-INTERRUPTED bug).
    vi.resetModules();
    const fresh = await import("@/lib/generation/repository");
    fresh.registerActiveJob(job.id);
    try {
      await getJob(user.id, job.id); // every read sweeps unregistered running rows
      const row = await db.generationJob.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe("running");
      expect(row?.statusError).toBeNull();
    } finally {
      fresh.unregisterActiveJob(job.id);
    }
  });
});

describe("documents & versions", () => {
  async function seededJob(analysisId: string) {
    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    const document = await ensureDocument(analysisId, "cv");
    return { job, document };
  }

  it("ensureDocument is get-or-create per (analysisId, kind)", async () => {
    const analysisId = await matchedAnalysisId();
    const { document } = await seededJob(analysisId);
    const again = await ensureDocument(analysisId, "cv");
    expect(again.id).toBe(document.id);

    const letter = await ensureDocument(analysisId, "cover_letter");
    expect(letter.id).not.toBe(document.id);
    expect(await db.generatedDocument.count({ where: { analysisId } })).toBe(2);
  });

  it("chains versions 1..n per document, one per producing job", async () => {
    const analysisId = await matchedAnalysisId();
    const { job: job1, document } = await seededJob(analysisId);
    const v1 = await appendVersion({
      documentId: document.id,
      producingJobId: job1.id,
      content: { claimIdVersion: 1, n: 1 },
      validationReport: cleanReport,
    });
    expect(v1.version).toBe(1);
    expect(v1.revision).toBe(0);

    const job2 = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    const v2 = await appendVersion({
      documentId: document.id,
      producingJobId: job2.id,
      content: { claimIdVersion: 1, n: 2 },
      validationReport: cleanReport,
    });
    expect(v2.version).toBe(2);

    expect((await getCurrentVersion(document.id))?.id).toBe(v2.id);

    // a job produces at most one version
    await expect(
      appendVersion({
        documentId: document.id,
        producingJobId: job1.id,
        content: {},
        validationReport: cleanReport,
      }),
    ).rejects.toMatchObject({ code: "GENERATION_INVALID_STATE" });
  });

  it("updateVersionContent bumps revision (omission-restore rewrites)", async () => {
    const analysisId = await matchedAnalysisId();
    const { job, document } = await seededJob(analysisId);
    const v1 = await appendVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1, summary: "old" },
      validationReport: cleanReport,
    });

    const edited = await updateVersionContent(v1.id, { claimIdVersion: 1, summary: "new" });
    expect(edited.revision).toBe(1);
    expect(edited.content).toMatchObject({ summary: "new" });
  });

  it("aggregates usage by runId from LlmUsageLog", async () => {
    const runId = "gen-run-1";
    await db.llmUsageLog.createMany({
      data: [
        { task: "generateTailoredCV", model: "m", runId, promptTokens: 10, completionTokens: 5, costUsd: 0.01, durationMs: 100 },
        { task: "factGuard", model: "m", runId, promptTokens: 1, completionTokens: 2, costUsd: 0.005, durationMs: 50 },
        { task: "other", model: "m", runId: "elsewhere", promptTokens: 99, completionTokens: 99, costUsd: 9, durationMs: 1 },
      ],
    });
    expect(await getRunUsage(runId)).toEqual({
      calls: 2,
      promptTokens: 11,
      completionTokens: 7,
      costUsd: 0.015,
    });
    expect(await getRunUsage("nope")).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });

  it("summarizes the document: version, gate matrix, flag summary", async () => {
    const analysisId = await matchedAnalysisId();
    const { job, document } = await seededJob(analysisId);

    // no version yet — matrix closed
    expect(await getDocumentSummary(document.id)).toEqual({
      documentId: document.id,
      currentVersion: null,
      downloadable: { pdf: false, docx: false, txt: false },
      summary: { blockers: 0, warnings: 0 },
      version: null,
    });

    // artifacts + passed extraction open the formats; the report never gates
    await appendVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1 },
      validationReport: {
        flags: [
          {
            code: "VERBATIM_FALLBACK",
            claim: "exp.e1.1",
            severity: "warning",
            resolution: "pending",
          },
        ],
        summary: { blockers: 0, warnings: 1 },
      },
      artifacts: [{ format: "pdf", storagePath: "x.pdf", sha256: "a", bytes: 1, gate: "verified" }],
      extractionCheck: { passed: true },
    });
    const open = (await getDocumentSummary(document.id))!;
    expect(open.currentVersion).toBe(1);
    expect(open.summary).toEqual({ blockers: 0, warnings: 1 });
    expect(open.downloadable).toEqual({ pdf: true, docx: false, txt: false });

    // a failed extraction check keeps the pdf closed even with artifacts
    const job2 = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    await appendVersion({
      documentId: document.id,
      producingJobId: job2.id,
      content: { claimIdVersion: 1 },
      validationReport: cleanReport,
      artifacts: [
        { format: "pdf", storagePath: "x.pdf", sha256: "a", bytes: 1, gate: "verified" },
        { format: "docx", storagePath: "x.docx", sha256: "a", bytes: 1, gate: "best_effort" },
      ],
      extractionCheck: { passed: false },
    });
    const gated = (await getDocumentSummary(document.id))!;
    expect(gated.currentVersion).toBe(2);
    expect(gated.downloadable).toEqual({ pdf: false, docx: true, txt: false });
  });

  it("cascades delete with the analysis", async () => {
    const analysisId = await matchedAnalysisId();
    const { job, document } = await seededJob(analysisId);
    await appendVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1 },
      validationReport: cleanReport,
    });
    await db.jobAnalysis.delete({ where: { id: analysisId } });
    expect(await db.generationJob.count()).toBe(0);
    expect(await db.generatedDocument.count()).toBe(0);
    expect(await db.generatedDocumentVersion.count()).toBe(0);
  });
});

describe("selection record persistence (feature 005)", () => {
  const selection = {
    included: [
      {
        entryId: "e1",
        kind: "experience",
        rank: 1,
        score: 0.9,
        basis: {
          evidenceRefs: [{ type: "bullet", id: "b1", snippet: "led 5 engineers" }],
          methodCredits: ["exact"],
          recency: 1,
        },
      },
    ],
    generatedAt: "2026-10-24T00:00:00.000Z",
  };

  async function seededJob(analysisId: string) {
    const job = await createGenerationJob(user.id, { analysisId, kind: "cv", settings: cvSettings() });
    const document = await ensureDocument(analysisId, "cv");
    return { job, document };
  }

  it("appendVersion defaults an absent selection to null", async () => {
    const analysisId = await matchedAnalysisId();
    const { job, document } = await seededJob(analysisId);
    const v = await appendVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1 },
      validationReport: cleanReport,
    });
    expect(v.selection).toBeNull(); // legacy/pre-feature shape
  });

  it("appendVersion persists a given selection; reads round-trip it", async () => {
    const analysisId = await matchedAnalysisId();
    const { job, document } = await seededJob(analysisId);
    const v = await appendVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1 },
      validationReport: cleanReport,
      selection,
    });
    expect(v.selection).toEqual(selection);

    // job-scoped read and deliverable read both surface the record
    expect((await getVersionForJob(job.id, document.id))?.selection).toEqual(selection);
    await markRunning(job.id, "run-1");
    await markSucceeded(job.id); // getLatestSuccessfulVersion filters on succeeded jobs
    expect((await getLatestSuccessfulVersion(document.id))?.selection).toEqual(selection);
  });

  it("upsertJobVersion: create path persists selection, retry refresh rewrites it", async () => {
    const analysisId = await matchedAnalysisId();
    const { job, document } = await seededJob(analysisId);

    const created = await upsertJobVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1 },
      validationReport: cleanReport,
      selection,
    });
    expect(created.selection).toEqual(selection);

    // a retry refreshes the row in place — selection is rewritten as given
    const refreshed = await upsertJobVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1, retried: true },
      validationReport: cleanReport,
    });
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.selection).toBeNull(); // absent = null (persist as given)
  });

  it("DocumentSummary surfaces selection on the version view", async () => {
    const analysisId = await matchedAnalysisId();
    const { job, document } = await seededJob(analysisId);
    await appendVersion({
      documentId: document.id,
      producingJobId: job.id,
      content: { claimIdVersion: 1 },
      validationReport: cleanReport,
      selection,
    });
    const summary = (await getDocumentSummary(document.id, { forJobId: job.id }))!;
    expect(summary.version?.selection).toEqual(selection);
  });
});
