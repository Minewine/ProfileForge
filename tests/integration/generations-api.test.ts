import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { createAnalysis, persistReport } from "@/lib/jobs/repository";
import { getOrCreateProfile } from "@/lib/profile/repository";
import { normalizeText } from "@/lib/text/normalize";
import { SelectionRecordSchema } from "@/lib/generation/schemas";
import type { MatchReport } from "@/lib/jobs/schemas";
import { resetAuth, signIn, type SessionUser } from "../support/auth";

vi.mock("@/lib/llm/router", () => ({
  callLLM: vi.fn(),
  registerTask: vi.fn(),
  resetTaskRegistry: vi.fn(),
  OPENROUTER_URL: "x",
}));

// The routes kick the pipeline without awaiting; capture the kick so tests drive
// runGenerationJob deterministically instead of racing a background run.
const h = vi.hoisted(() => ({ kicked: [] as string[] }));
vi.mock("@/lib/generation/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/generation/pipeline")>();
  return {
    ...actual,
    kickoffGenerationJob: (jobId: string) => {
      h.kicked.push(jobId);
    },
  };
});

// connection() only exists inside a Next request scope; direct handler invocation
// in tests has none (see src/app/api/settings/models/route.ts for the route pattern).
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

// US3: the extraction gate is wrapped for the bounded-retry test — counts
// calls and can force failure without touching the real renderer.
const gate = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("@/lib/generation/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/generation/verify")>();
  return {
    ...actual,
    runExtractionGate: async (...args: Parameters<typeof actual.runExtractionGate>) => {
      gate.calls += 1;
      if (!gate.fail) return actual.runExtractionGate(...args);
      return {
        passed: false,
        pages: 2,
        level1: { passed: false, elements: [{ element: "name", expected: "x", found: false }] },
        level2: { passed: false, threshold: 0.95, blocks: [] },
      };
    },
  };
});

const BASE = "http://localhost:3000/api/generations";

// Signed-in identity for the suite (multi-user isolation, feature 008) —
// fixtures created via repository functions are scoped to this user.
let user: SessionUser;

const JD_EN = `Senior Backend Engineer role. We require strong experience in distributed systems and Kubernetes.
You must have at least 5 years of Go development. A Bachelor's degree in Computer Science is required.
Nice to have: Kafka, Terraform. French language skills are a plus for our Montreal office.`;

const JD_FR = `Ingénieur logiciel senior. Vous devez maîtriser Kubernetes et Go (au moins 5 ans d'expérience).
Un diplôme universitaire en informatique est exigé. Atout : expérience avec Kafka et Terraform.
Vous participerez à la conception de notre plateforme de données, encadrerez une petite équipe
de développeurs et travaillerez avec les équipes produit sur les exigences fonctionnelles.
La maîtrise de l'anglais technique est nécessaire ; la connaissance du secteur financier est un plus.`;

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

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function args(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function clean() {
  await rm(path.join(process.env.UPLOADS_DIR ?? "./uploads-test", "generations"), {
    recursive: true,
    force: true,
  });
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

async function matchedAnalysis(text = JD_EN): Promise<string> {
  const { analysis } = await createAnalysis(user.id, text);
  await persistReport(user.id, analysis.id, 1, reportFixture());
  return analysis.id;
}

async function createGen(overrides: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/generations/route");
  const analysisId = await matchedAnalysis();
  const res = await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv", ...overrides }) as never);
  return { res, body: await res.json(), analysisId };
}

beforeEach(async () => {
  await resetAuth();
  user = await signIn("generations-api@example.com");
  await clean();
  h.kicked.length = 0;
  gate.fail = false;
  gate.calls = 0;
  vi.mocked((await import("@/lib/llm/router")).callLLM).mockReset();
});

describe("POST /api/generations", () => {
  it("guards: 409 ANALYSIS_NOT_MATCHED, 400 invalid settings, 404 unknown", async () => {
    const { POST } = await import("@/app/api/generations/route");

    // analysis exists but is not matched
    const { analysis } = await createAnalysis(user.id, JD_EN);
    const notMatched = await POST(jsonReq(BASE, "POST", { analysisId: analysis.id, kind: "cv" }) as never);
    expect(notMatched.status).toBe(409);
    expect((await notMatched.json()).error.code).toBe("ANALYSIS_NOT_MATCHED");

    // unknown analysis
    const unknown = await POST(jsonReq(BASE, "POST", { analysisId: "missing", kind: "cv" }) as never);
    expect(unknown.status).toBe(404);

    // invalid settings / kind → 400
    const analysisId = await matchedAnalysis();
    const badSettings = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { pageBudget: 9 } }) as never,
    );
    expect(badSettings.status).toBe(400);
    const badKind = await POST(jsonReq(BASE, "POST", { analysisId, kind: "poster" }) as never);
    expect(badKind.status).toBe(400);
  });

  it("allows generation despite overlapping experience dates (non-blocking warning only)", async () => {
    const analysisId = await matchedAnalysis();
    const profile = await getOrCreateProfile(user.id);
    const created = await db.experience.createMany({
      data: [
        { profileId: profile.id, company: "Overlap A", title: "T", startDate: "2020-01", endDate: "2022-01" },
        { profileId: profile.id, company: "Overlap B", title: "T", startDate: "2021-01", endDate: "2023-01" },
      ],
    });
    expect(created.count).toBe(2);

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never);
    expect(res.status).toBe(202);
  });

  it("returns 202 with resolved settings and kicks the pipeline without awaiting", async () => {
    const analysisId = await matchedAnalysis(JD_FR); // fr JD → fr default
    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { notes: "emphasize backend" } }) as never,
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.generationJobId).toEqual(expect.any(String));
    expect(body.documentId).toEqual(expect.any(String));
    expect(body.settings).toEqual({
      outputLanguage: "fr",
      pageBudget: 2,
      tone: "professional",
      summaryMaxWords: 60,
      templateId: "ats",
      notes: "emphasize backend",
    });

    const profile = await getOrCreateProfile(user.id);
    const row = await db.generationJob.findUniqueOrThrow({ where: { id: body.generationJobId } });
    expect(row).toMatchObject({ status: "queued", kind: "cv", attempt: 1, profileVersion: profile.version });
    expect(row.settings).toMatchObject({ outputLanguage: "fr" });

    // the document identity exists immediately (version arrives with the pipeline)
    expect(await db.generatedDocument.findUnique({ where: { id: body.documentId } })).not.toBeNull();
    // kickoff fired
    expect(h.kicked).toContain(body.generationJobId);
  });

  it("accepts settings.summaryMaxWords (frozen on the job, returned in the 202 body) and rejects out-of-bounds values (T020)", async () => {
    const analysisId = await matchedAnalysis(JD_EN);
    const { POST } = await import("@/app/api/generations/route");

    // 400 outside 30..120 — bounds enforced at the input schema
    const tooBig = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { summaryMaxWords: 400 } }) as never,
    );
    expect(tooBig.status).toBe(400);
    const tooSmall = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { summaryMaxWords: 29 } }) as never,
    );
    expect(tooSmall.status).toBe(400);

    // a valid non-default value is accepted, returned in the 202 body, frozen on the job row
    const res = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { summaryMaxWords: 90 } }) as never,
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.settings).toMatchObject({ summaryMaxWords: 90 });
    const row = await db.generationJob.findUniqueOrThrow({ where: { id: body.generationJobId } });
    expect(row.settings).toMatchObject({ summaryMaxWords: 90 });
  });
});

describe("GET /api/generations(/[id])", () => {
  it("polls a job to succeeded with document summary and usage (empty profile → placeholder version, no LLM call)", async () => {
    const { body: created } = await createGen();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId); // deterministic completion

    const { GET } = await import("@/app/api/generations/[id]/route");
    const res = await GET(null as never, args(created.generationJobId));
    expect(res.status).toBe(200);
    const polled = await res.json();
    expect(polled.job).toMatchObject({
      id: created.generationJobId,
      kind: "cv",
      status: "succeeded",
      statusError: null,
      attempt: 1,
      profileVersion: expect.any(Number),
      notice: null,
    });
    expect(polled.job.runId).toEqual(expect.any(String));
    expect(polled.job.settings).toMatchObject({ pageBudget: 2, outputLanguage: "en" });
    expect(polled.document).toEqual({
      documentId: created.documentId,
      currentVersion: 1, // empty pinned snapshot → placeholder version without an LLM call
      downloadable: { pdf: true, docx: true, txt: false },
      summary: { blockers: 0, warnings: 0 },
      version: {
        version: 1,
        revision: 0,
        selection: { included: [], generatedAt: expect.any(String) }, // feature 005: the plan always records (empty profile → nothing included)
        content: {
          claimIdVersion: 1,
          summary: "",
          summaryProvenance: [],
          experience: [],
          education: [],
          projects: [],
          certifications: [],
          skills: [],
          omissions: [],
        },
        validationReport: {
          flags: [],
          summary: { blockers: 0, warnings: 0 },
        },
        // US3: the empty render still passes the (vacuous) extraction gate
        extractionCheck: {
          passed: true,
          pages: 1,
          level1: { passed: true, elements: [] },
          level2: { passed: true, threshold: 0.95, blocks: [] },
        },
      },
    });
    expect(polled.usage).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
    expect(await db.generatedDocumentVersion.count()).toBe(1);
    expect((await import("@/lib/llm/router")).callLLM).not.toHaveBeenCalled();

    // unknown id → 404
    expect((await GET(null as never, args("missing"))).status).toBe(404);
  });

  it("lists by analysisId (polling-friendly) and 400s without the param", async () => {
    const { body: created, analysisId } = await createGen();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);

    const { GET } = await import("@/app/api/generations/route");
    const res = await GET(new Request(`${BASE}?analysisId=${analysisId}`) as never);
    expect(res.status).toBe(200);
    const { generations } = await res.json();
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      generationJobId: created.generationJobId,
      kind: "cv",
      status: "succeeded",
      attempt: 1,
      version: 1,
      statusError: null,
    });
    expect(typeof generations[0].createdAt).toBe("string");
    expect(typeof generations[0].finishedAt).toBe("string");

    const missing = await GET(new Request(BASE) as never);
    expect(missing.status).toBe(400);
  });
});

describe("cancel & retry", () => {
  it("cancels from queued: final state cancelled at the first stage boundary", async () => {
    const { body: created } = await createGen(); // kickoff captured → still queued
    const { POST } = await import("@/app/api/generations/[id]/cancel/route");

    const res = await POST(null as never, args(created.generationJobId));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("queued");

    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const row = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).not.toBeNull();

    expect((await POST(null as never, args("missing"))).status).toBe(404);
  });

  it("refuses cancel of a terminal job with 409 GENERATION_INVALID_STATE", async () => {
    const { body: created } = await createGen();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId); // → succeeded

    const { POST } = await import("@/app/api/generations/[id]/cancel/route");
    const refused = await POST(null as never, args(created.generationJobId));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("GENERATION_INVALID_STATE");
  });

  it("retries a failed job: attempt 2, fresh runId, pipeline re-kicked to succeeded", async () => {
    const { body: created } = await createGen();
    await db.generationJob.update({
      where: { id: created.generationJobId },
      data: { status: "failed", statusError: "LLM_UNAVAILABLE: provider down" },
    });

    const kickedBefore = h.kicked.length;
    const { POST } = await import("@/app/api/generations/[id]/retry/route");
    const res = await POST(null as never, args(created.generationJobId));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ generationJobId: created.generationJobId, attempt: 2 });

    const row = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(row.status).toBe("queued");
    expect(row.attempt).toBe(2);
    expect(row.runId).toEqual(expect.any(String));
    expect(row.statusError).toBeNull();
    expect(h.kicked.length).toBe(kickedBefore + 1); // retry re-enqueues

    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const done = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(done.status).toBe("succeeded");
    expect(done.attempt).toBe(2);

    expect((await POST(null as never, args("missing"))).status).toBe(404);
  });

  it("refuses retry of a queued (non-failed) job with 409", async () => {
    const { body: created } = await createGen(); // kickoff captured → still queued
    const { POST } = await import("@/app/api/generations/[id]/retry/route");
    const refused = await POST(null as never, args(created.generationJobId));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("GENERATION_INVALID_STATE");
  });
});

// --- US1: full pipeline (plan → draft → persist), T013 ---

async function seedGenerationProfile() {
  const { createEntry } = await import("@/lib/profile/repository");
  // repository mutations so each step pins a real ProfileSnapshot version
  const e1 = await createEntry(user.id, "experience", {
    company: "Acme",
    title: "Platform Engineer",
    startDate: "2021-01",
    endDate: "present",
    skillsUsed: ["Go", "Kubernetes"],
    bullets: [
      { text: "Operated Kubernetes clusters serving 2M requests per day.", order: 0 },
      { text: "Led a team of 5 engineers.", order: 1 },
    ],
  });
  const p1 = await createEntry(user.id, "projects", {
    name: "ATS Checker",
    bullets: [{ text: "Built an ATS compliance checker used by 400 users.", order: 0 }],
  });
  const ed1 = await createEntry(user.id, "education", {
    institution: "McGill University",
    degree: "BSc",
    field: "Computer Science",
    startDate: "2012-09",
    endDate: "2016-05",
  });
  const c1 = await createEntry(user.id, "certifications", { title: "CKA", issuer: "CNCF", issueDate: "2023-04" });
  const s1 = await createEntry(user.id, "skills", { name: "Kubernetes" });
  const bullets = await db.bullet.findMany({ where: { experienceId: e1.id }, orderBy: { order: "asc" } });
  return { e1: e1.id, p1: p1.id, ed1: ed1.id, c1: c1.id, s1: s1.id, bullets };
}

async function matchedAnalysisWithEvidence(seed: Awaited<ReturnType<typeof seedGenerationProfile>>) {
  const { analysis } = await createAnalysis(user.id, JD_EN);
  const profile = await getOrCreateProfile(user.id);
  await persistReport(
    user.id,
    analysis.id,
    profile.version,
    reportFixture({
      requirements: [
        {
          id: "r1",
          text: "Kubernetes",
          importance: "must",
          isHardConstraint: true,
          status: "strong",
          matchMethod: "exact",
          evidence: [
            { type: "skill", id: seed.s1, snippet: "Kubernetes" },
            { type: "bullet", id: seed.e1, snippet: "Platform Engineer — Acme" },
          ],
          note: null,
        },
        {
          id: "r2",
          text: "Team leadership",
          importance: "nice",
          isHardConstraint: false,
          status: "strong",
          matchMethod: "semantic",
          evidence: [{ type: "bullet", id: seed.e1, snippet: "Led a team" }],
          note: null,
        },
      ],
      recommendedKeywords: ["Kubernetes", "Go"],
    }),
  );
  return analysis.id;
}

function mockLLM(data: unknown) {
  return {
    data,
    usage: { promptTokens: 120, completionTokens: 80, costUsd: 0.02 },
    modelUsed: "test/premium",
  };
}

describe("US1 pipeline: plan → draft → persist", () => {
  it("happy path: mocked premium draft → succeeded job, version 1 with content + provenance", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue(
      mockLLM({
        summary: "Platform engineer with deep Kubernetes operations experience.",
        items: [
          {
            key: `exp.${seed.e1}.1`,
            text: "Operated Kubernetes clusters at a scale of 2M requests per day.",
            rationale: "JD-critical requirement",
          },
        ],
      }) as never,
    );

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never);
    expect(res.status).toBe(202);
    const created = await res.json();
    const profile = await getOrCreateProfile(user.id);
    expect(created.settings).toMatchObject({ outputLanguage: "en", pageBudget: 2 });

    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);

    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job).toMatchObject({ status: "succeeded", statusError: null, notice: null });
    expect(job.profileVersion).toBe(profile.version); // pinned at creation (research R5)

    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });
    expect(version.version).toBe(1);
    const content = version.content as import("@/lib/generation/schemas").GeneratedCVContent;

    // tailored bullet from the keyed LLM item; the skipped key falls back verbatim
    const bullets = content.experience.find((x) => x.id === seed.e1)!.bullets;
    expect(bullets[0]).toEqual({
      claimId: `exp.${seed.e1}.1`,
      text: "Operated Kubernetes clusters at a scale of 2M requests per day.",
      sourceBulletIds: [seed.bullets[0].id],
      rationale: "JD-critical requirement",
    });
    expect(bullets[1]).toEqual({
      claimId: `exp.${seed.e1}.2`,
      text: "Led a team of 5 engineers.",
      sourceBulletIds: [seed.bullets[1].id],
    });
    expect(content.education[0]).toEqual({
      id: seed.ed1,
      claimId: `edu.${seed.ed1}`,
      text: "BSc · Computer Science · McGill University",
      sourceIds: [seed.ed1],
    });
    expect(content.certifications[0]).toEqual({ id: seed.c1, claimId: `cert.${seed.c1}`, text: "CKA · CNCF", sourceIds: [seed.c1] });

    expect(content.summary).toBe("Platform engineer with deep Kubernetes operations experience.");
    expect(content.summaryProvenance.length).toBeGreaterThan(0);
    expect(content.skills).toEqual(["Kubernetes"]); // exact skill match, rendered in JD terminology
    expect(content.omissions).toEqual([]); // present but empty until the US3 fit loop

    // US1 independent test: every provenance id resolves to the pinned snapshot
    const snapshot = await db.profileSnapshot.findUniqueOrThrow({
      where: { profileId_version: { profileId: profile.id, version: job.profileVersion } },
    });
    const data = snapshot.data as {
      experience?: Array<{ id: string; bullets?: Array<{ id: string }> }>;
      projects?: Array<{ id: string; bullets?: Array<{ id: string }> }>;
      education?: Array<{ id: string }>;
      certifications?: Array<{ id: string }>;
      skills?: Array<{ id: string }>;
    };
    const snapshotIds = new Set<string>([
      ...(data.experience ?? []).flatMap((e) => [e.id, ...(e.bullets ?? []).map((b) => b.id)]),
      ...(data.projects ?? []).flatMap((p) => [p.id, ...(p.bullets ?? []).map((b) => b.id)]),
      ...(data.education ?? []).map((e) => e.id),
      ...(data.certifications ?? []).map((c) => c.id),
      ...(data.skills ?? []).map((s) => s.id),
    ]);
    const provenanceIds = [
      ...content.summaryProvenance.map((e) => e.id),
      ...content.experience.flatMap((e) => e.bullets.flatMap((b) => b.sourceBulletIds)),
      ...content.projects.flatMap((p) => p.bullets.flatMap((b) => b.sourceBulletIds)),
      ...content.education.flatMap((e) => e.sourceIds),
      ...content.certifications.flatMap((c) => c.sourceIds),
    ];
    expect(provenanceIds.length).toBeGreaterThan(0);
    for (const id of provenanceIds) expect(snapshotIds.has(id)).toBe(true);

    // warnings-only report (Fact Guard removed): draft fallbacks surface as warnings
    const report = version.validationReport as {
      flags: Array<{ code: string; claim: string; severity: string }>;
      summary: { blockers: number; warnings: number };
    };
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "VERBATIM_FALLBACK", claim: `exp.${seed.e1}.2`, severity: "warning" }),
    );
    expect(report.summary).toEqual({ blockers: 0, warnings: 5 }); // exp bullet 2, title, project, education, certification (feature 005: the title key is a plan item now)

    const { GET } = await import("@/app/api/generations/[id]/route");
    const polled = await (await GET(null as never, args(created.generationJobId))).json();
    expect(polled.document).toMatchObject({
      documentId: created.documentId,
      currentVersion: 1,
      downloadable: { pdf: true, docx: true, txt: false },
      summary: { blockers: 0, warnings: 5 },
      version: {
        version: 1,
        revision: 0,
        content: {
          claimIdVersion: 1,
          summary: "Platform engineer with deep Kubernetes operations experience.",
          skills: ["Kubernetes"],
        },
        validationReport: {
          summary: { blockers: 0, warnings: 5 },
        },
      },
    });
    expect(polled.usage).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });

  it("skips dangling MatchReport evidence with a stale-analysis notice (research R5)", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { deleteEntry } = await import("@/lib/profile/repository");
    await deleteEntry(user.id, "experience", seed.e1); // evidenced entry deleted after the match

    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue(mockLLM({ summary: "", items: [] }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never);
    const created = await res.json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);

    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");
    expect(job.notice).toBe("stale-analysis");

    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
    });
    const content = version.content as import("@/lib/generation/schemas").GeneratedCVContent;
    expect(content.experience.find((x) => x.id === seed.e1)).toBeUndefined(); // skipped, never fabricated
    expect(content.skills).toEqual(["Kubernetes"]); // resolvable skill evidence still counts
  });

  it("regeneration with changed settings appends version 2 (FR-018)", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue(mockLLM({ summary: "v1 summary", items: [] }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const first = await (await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never)).json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(first.generationJobId);

    const secondRes = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { pageBudget: 1, notes: "tighter" } }) as never,
    );
    expect(secondRes.status).toBe(202);
    const second = await secondRes.json();
    expect(second.documentId).toBe(first.documentId); // same (analysisId, kind) document identity
    expect(second.settings).toMatchObject({ pageBudget: 1, notes: "tighter" });

    vi.mocked(callLLM).mockResolvedValue(mockLLM({ summary: "v2 summary", items: [] }) as never);
    await runGenerationJob(second.generationJobId);

    const versions = await db.generatedDocumentVersion.findMany({
      where: { documentId: first.documentId },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect((versions[0].content as { summary: string }).summary).toBe("v1 summary");
    expect((versions[1].content as { summary: string }).summary).toBe("v2 summary");
  });
});

// --- US1 selection record (feature 005): the cut, the persisted basis, the route ---

/** A rich profile: 5 experience entries (over the cap of 4 at budget 2). e1 is
 *  evidenced + present (rank 1); e2 carries 40 long bullets — drafted by the
 *  plan (caps count entries) but demoted whole by the fit loop at tight budgets,
 *  producing a page_budget omission ON TOP of the selection cut. e2–e5 have
 *  digit-free identical bullet text so recency alone decides their ranks. */
async function seedRichProfile() {
  const { createEntry } = await import("@/lib/profile/repository");
  const light = "Delivered a complex cross-team initiative with measurable outcomes and follow-through.";
  const heavy =
    "Conception et livraison d'un composant critique avec des métriques de disponibilité mesurables et une revue par les pairs systématique.";
  const e1 = await createEntry(user.id, "experience", {
    company: "Present Corp",
    title: "Platform Engineer",
    startDate: "2024-01", // disjoint ranges — the POST guard refuses overlapping dates
    endDate: "present",
    skillsUsed: ["Kubernetes"],
    bullets: [
      { text: "Operated Kubernetes clusters serving 2M requests per day.", order: 0 },
      { text: "Led a team of 5 engineers.", order: 1 },
    ],
  });
  const e2 = await createEntry(user.id, "experience", {
    company: "Big Corp",
    title: "Engineer",
    startDate: "2022-01",
    endDate: "2023-06",
    bullets: Array.from({ length: 40 }, (_, i) => ({ text: `${heavy} (${i + 1})`, order: i })),
  });
  const e3 = await createEntry(user.id, "experience", {
    company: "Mid Corp",
    title: "Engineer",
    startDate: "2019-01",
    endDate: "2020-06",
    bullets: [{ text: light, order: 0 }],
  });
  const e4 = await createEntry(user.id, "experience", {
    company: "Old Corp",
    title: "Engineer",
    startDate: "2014-01",
    endDate: "2015-06",
    bullets: [{ text: light, order: 0 }],
  });
  const e5 = await createEntry(user.id, "experience", {
    company: "Ancient Corp",
    title: "Engineer",
    startDate: "2009-01",
    endDate: "2010-06",
    bullets: [{ text: light, order: 0 }],
  });
  const s1 = await createEntry(user.id, "skills", { name: "Kubernetes" });
  return { e1: e1.id, e2: e2.id, e3: e3.id, e4: e4.id, e5: e5.id, s1: s1.id };
}

/** A matched analysis whose single exact requirement cites the present entry —
 *  e1 ranks 1; e2–e5 rank 2..5 by recency alone. */
async function matchedRichAnalysis(seed: Awaited<ReturnType<typeof seedRichProfile>>): Promise<string> {
  const { analysis } = await createAnalysis(user.id, JD_EN);
  const profile = await getOrCreateProfile(user.id);
  await persistReport(
    user.id,
    analysis.id,
    profile.version,
    reportFixture({
      requirements: [
        {
          id: "r1",
          text: "Kubernetes",
          importance: "must",
          isHardConstraint: true,
          status: "strong",
          matchMethod: "exact",
          evidence: [
            { type: "skill", id: seed.s1, snippet: "Kubernetes" },
            { type: "bullet", id: seed.e1, snippet: "Platform Engineer — Present Corp" },
          ],
          note: null,
        },
      ],
      recommendedKeywords: ["Kubernetes"],
    }),
  );
  return analysis.id;
}

describe("US1 selection record (feature 005)", () => {
  it("a rich generation persists the selection record, returns it from GET document, and distinguishes selection from page_budget omissions; regeneration appends its own record", async () => {
    const seed = await seedRichProfile();
    const analysisId = await matchedRichAnalysis(seed);
    const { callLLM } = await import("@/lib/llm/router");
    // the premium draft echoes every plan key verbatim; the guard supports every claim
    vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: {
      plan?: Array<{ key: string; sourceText: string[] }>;
      claims?: Array<{ claimId: string }>;
    } }) => {
      return Promise.resolve(
        mockLLM({
          summary: "Platform engineer with deep Kubernetes operations experience.",
          items: (payload.plan ?? []).map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
        }),
      );
    }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never); // default budget 2
    expect(res.status).toBe(202);
    const created = await res.json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");

    const v1 = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });

    // the persisted record parses against the REAL schema and lists the top-4
    // ranked experience entries (cap 4 at budget 2) — e5 is not included
    const selection = SelectionRecordSchema.parse(v1.selection);
    expect(selection.included.map((e) => [e.entryId, e.kind, e.rank])).toEqual([
      [seed.e1, "experience", 1],
      [seed.e2, "experience", 2],
      [seed.e3, "experience", 3],
      [seed.e4, "experience", 4],
    ]);
    const e1rec = selection.included[0];
    expect(e1rec.basis.recency).toBe(1); // present
    expect(e1rec.basis.methodCredits).toEqual(["exact"]); // distinct methods among the citations
    expect(e1rec.basis.evidenceRefs).toEqual([
      { type: "bullet", id: seed.e1, snippet: "Platform Engineer — Present Corp" },
    ]);
    const e2rec = selection.included[1];
    expect(e2rec.basis.evidenceRefs).toEqual([]); // uncited entry — empty basis
    expect(e2rec.basis.methodCredits).toEqual([]);
    expect(e2rec.basis.recency).toBeGreaterThan(0);
    expect(e2rec.basis.recency).toBeLessThan(1);

    // the omissions list is complete by construction: the selection cut seeded
    // e5 at draft time; the fit loop demoted only e4 — three entries fit the
    // 2-page budget, so demotion stops there (measure-and-demote, not a quota)
    const content1 = v1.content as import("@/lib/generation/schemas").GeneratedCVContent;
    expect(content1.experience.map((e) => e.id)).toEqual([seed.e1, seed.e2, seed.e3]);
    expect(content1.omissions.map((o) => [o.id, o.reason])).toEqual([
      [seed.e5, "selection"],
      [seed.e4, "page_budget"],
    ]);

    // GET .../document returns the record and the same distinguishable omissions
    const { GET } = await import("@/app/api/generations/[id]/document/route");
    const docRes = await GET(null as never, args(created.generationJobId));
    expect(docRes.status).toBe(200);
    const body = await docRes.json();
    expect(SelectionRecordSchema.parse(body.selection)).toEqual(selection);
    expect(body.omissions).toEqual(content1.omissions);

    // regeneration appends a new version with its OWN record (budget 1 → cap 2)
    const second = await (
      await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { pageBudget: 1 } }) as never)
    ).json();
    await runGenerationJob(second.generationJobId);
    const job2 = await db.generationJob.findUniqueOrThrow({ where: { id: second.generationJobId } });
    expect(job2.status).toBe("succeeded");

    const versions = await db.generatedDocumentVersion.findMany({
      where: { documentId: created.documentId },
      orderBy: { version: "asc" },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const selection2 = SelectionRecordSchema.parse(versions[1].selection);
    expect(selection2.included.map((e) => [e.entryId, e.rank])).toEqual([
      [seed.e1, 1],
      [seed.e2, 2],
    ]);
    const content2 = versions[1].content as import("@/lib/generation/schemas").GeneratedCVContent;
    const reasons2 = new Map(content2.omissions.map((o) => [o.id, o.reason]));
    expect(reasons2.get(seed.e3)).toBe("selection"); // cut at budget 1
    expect(reasons2.get(seed.e4)).toBe("selection");
    expect(reasons2.get(seed.e5)).toBe("selection");
    expect(reasons2.get(seed.e2)).toBe("page_budget"); // drafted by the plan, demoted by fit
    expect(content2.experience.map((e) => e.id)).toEqual([seed.e1]);
  });
});

// --- US2: Fact Guard gates download + claim resolution, T020 ---

type FlagShape = { code: string; claim: string; severity: string; resolution: string; confirmedAt?: string };
type ReportShape = {
  flags: FlagShape[];
  summary: { blockers: number; warnings: number };
};

type Seed = Awaited<ReturnType<typeof seedGenerationProfile>>;

function claimIds(seed: Seed) {
  return {
    summary: "summary",
    e1b1: `exp.${seed.e1}.1`,
    e1b2: `exp.${seed.e1}.2`,
    proj: `proj.${seed.p1}.1`,
    edu: `edu.${seed.ed1}`,
    cert: `cert.${seed.c1}`,
  };
}

/** The 2M-requests bullet text the clean-export mocks draft (matches evidence). */
const FIXED_TEXT = "Operated Kubernetes clusters serving 2M requests per day.";

describe("GET /api/generations/[id]/document", () => {
  it("returns the full current version; 409 while the job has not succeeded; 404 unknown job", async () => {
    const seed = await seedGenerationProfile();
    const ids = claimIds(seed);
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation((({ payload }: { payload: { plan?: Array<{ key: string; sourceText: string[] }> } }) => {
      return Promise.resolve(
        mockLLM({
          summary: "Platform engineer with deep Kubernetes operations experience.",
          items: [
            { key: ids.e1b1, text: FIXED_TEXT },
            ...(payload.plan ?? [])
              .filter((i) => i.key.startsWith("expTitle."))
              .map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
          ],
        }),
      );
    }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const created = await (await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never)).json();
    const { GET } = await import("@/app/api/generations/[id]/document/route");

    const early = await GET(null as never, args(created.generationJobId)); // still queued
    expect(early.status).toBe(409);
    expect((await early.json()).error.code).toBe("GENERATION_INVALID_STATE");

    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);

    const res = await GET(null as never, args(created.generationJobId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      version: 1,
      revision: 0,
      // feature 005: the plan stage records its selection (one entry per section here)
      selection: {
        included: [
          { entryId: seed.e1, kind: "experience", rank: 1 },
          { entryId: seed.p1, kind: "project", rank: 1 },
          { entryId: seed.ed1, kind: "education", rank: 1 },
          { entryId: seed.c1, kind: "certification", rank: 1 },
        ],
      },
      omissions: [],
      artifacts: expect.arrayContaining([
        expect.objectContaining({ format: "pdf", gate: "verified" }),
        expect.objectContaining({ format: "docx", gate: "best_effort" }),
      ]),
      canDownload: { pdf: true, docx: true, txt: false },
      validationReport: {
        summary: { blockers: 0, warnings: 4 },
      },
    });
    expect(body.content).toMatchObject({ claimIdVersion: 1, skills: ["Kubernetes"] });
    expect(body.validationReport.flags.every((f: FlagShape) => f.severity === "warning")).toBe(true);

    expect((await GET(null as never, args("missing"))).status).toBe(404);
  });
});

// --- US3: verified ATS export (render → fit → gate → artifacts → download), T030 ---

function uploadsPath(...parts: string[]): string {
  return path.join(process.env.UPLOADS_DIR ?? "./uploads-test", ...parts);
}

/** A clean generation: no blockers (valid numbers), semantic layer run → every
 *  download gate opens and the version carries gate-verified artifacts. */
async function setupCleanExport(seed: Seed) {
  const ids = claimIds(seed);
  const analysisId = await matchedAnalysisWithEvidence(seed);
  const { callLLM } = await import("@/lib/llm/router");
  vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: { plan?: Array<{ key: string; sourceText: string[] }>; claims?: Array<{ claimId: string }> } }) => {
    return Promise.resolve(
      mockLLM({
        summary: "Platform engineer with deep Kubernetes operations experience.",
        items: [
          { key: ids.e1b1, text: FIXED_TEXT },
          // feature 005: echo the title keys so the clean export stays clean
          ...(payload.plan ?? [])
            .filter((i) => i.key.startsWith("expTitle."))
            .map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
        ],
      }),
    );
  }) as never);

  const { POST } = await import("@/app/api/generations/route");
  const res = await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never);
  const created = await res.json();
  const { runGenerationJob } = await import("@/lib/generation/pipeline");
  await runGenerationJob(created.generationJobId);
  return created;
}

describe("US3: verified ATS export", () => {
  it("succeeded job writes the pdf artifact only after the gate passes (extractionCheck + sha256/bytes stored, files on disk)", async () => {
    const seed = await seedGenerationProfile();
    const created = await setupCleanExport(seed);

    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");
    expect(gate.calls).toBe(1); // passed on the first attempt — no retries needed

    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
    });
    const extractionCheck = version.extractionCheck as {
      passed: boolean;
      level1: { passed: boolean };
      level2: { passed: boolean; blocks: unknown[] };
    };
    expect(extractionCheck.passed).toBe(true);
    expect(extractionCheck.level1.passed).toBe(true);
    expect(extractionCheck.level2.passed).toBe(true);
    expect(extractionCheck.level2.blocks.length).toBeGreaterThan(0);

    type ArtifactRow = { format: string; storagePath: string; sha256: string; bytes: number; gate: string };
    const artifacts = version.artifacts as ArtifactRow[];
    expect(artifacts.map((a) => a.format).sort()).toEqual(["docx", "pdf"]);

    const pdf = artifacts.find((a) => a.format === "pdf")!;
    expect(pdf.gate).toBe("verified"); // pdf only after passing
    expect(pdf.storagePath).toBe(uploadsPath("generations", version.id, "cv.pdf"));
    const pdfBytes = await readFile(pdf.storagePath);
    expect(pdf.sha256).toBe(createHash("sha256").update(pdfBytes).digest("hex"));
    expect(pdf.bytes).toBe(pdfBytes.byteLength);
    expect(pdfBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const docx = artifacts.find((a) => a.format === "docx")!;
    expect(docx.gate).toBe("best_effort"); // ungated by extraction (parent exception)
    expect(existsSync(docx.storagePath)).toBe(true);
  });

  it("gate failure: bounded re-render retries (max 3) → job fails EXPORT_GATE_FAILED, results stored, no artifact on disk", async () => {
    gate.fail = true;
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: { plan?: Array<{ key: string; sourceText: string[] }>; claims?: Array<{ claimId: string }> } }) => {
      return Promise.resolve(mockLLM({ summary: "Platform engineer.", items: [] }));
    }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never);
    const created = await res.json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);

    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("failed");
    expect(job.statusError).toContain("EXPORT_GATE_FAILED");
    expect(gate.calls).toBe(3); // bounded: exactly three attempts total

    // the failing check results are stored on the version (no artifacts, no files)
    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
    });
    expect((version.extractionCheck as { passed: boolean }).passed).toBe(false);
    expect(version.artifacts).toEqual([]);
    expect(existsSync(uploadsPath("generations", version.id))).toBe(false); // SC-003: never offered

    // download refuses (job not succeeded → 409 GENERATION_INVALID_STATE)
    const { GET: download } = await import("@/app/api/generations/[id]/download/route");
    const refused = await download(
      new Request(`${BASE}/${created.generationJobId}/download?format=pdf`) as never,
      args(created.generationJobId),
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("GENERATION_INVALID_STATE");

    // the stored results surface through the polling endpoint (UI gate-failure state)
    const { GET: poll } = await import("@/app/api/generations/[id]/route");
    const polled = await (await poll(null as never, args(created.generationJobId))).json();
    expect(polled.document.version.extractionCheck.passed).toBe(false);
  });

  it("retrying a gate-failed job reuses its version row (one version per job) and can succeed on the retry", async () => {
    gate.fail = true;
    const seed = await seedGenerationProfile();
    const ids = claimIds(seed);
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: { plan?: Array<{ key: string; sourceText: string[] }>; claims?: Array<{ claimId: string }> } }) => {
      return Promise.resolve(
        mockLLM({
          summary: "Platform engineer with deep Kubernetes operations experience.",
          items: [
            { key: ids.e1b1, text: FIXED_TEXT },
            ...(payload.plan ?? [])
              .filter((i) => i.key.startsWith("expTitle."))
              .map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
          ],
        }),
      );
    }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const created = await (
      await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never)
    ).json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId); // → failed EXPORT_GATE_FAILED (version stored)
    expect((await db.generatedDocumentVersion.count({ where: { documentId: created.documentId } }))).toBe(1);

    gate.fail = false; // the retry renders cleanly
    const { POST: retry } = await import("@/app/api/generations/[id]/retry/route");
    const retried = await retry(null as never, args(created.generationJobId));
    expect(retried.status).toBe(202);
    await runGenerationJob(created.generationJobId);

    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");
    expect(job.attempt).toBe(2);

    // still exactly one version for this job — refreshed in place, artifacts on it
    const versions = await db.generatedDocumentVersion.findMany({ where: { documentId: created.documentId } });
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect((versions[0].extractionCheck as { passed: boolean }).passed).toBe(true);
    expect((versions[0].artifacts as Array<{ format: string }>).map((a) => a.format).sort()).toEqual(["docx", "pdf"]);
    expect(existsSync(uploadsPath("generations", versions[0].id, "cv.pdf"))).toBe(true);
  });

  it("download streams pdf/docx with Content-Disposition; txt → 409 for a cv (no txt artifact)", async () => {
    const seed = await seedGenerationProfile();
    const created = await setupCleanExport(seed);
    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
    });

    const { GET: download } = await import("@/app/api/generations/[id]/download/route");
    const pdf = await download(
      new Request(`${BASE}/${created.generationJobId}/download?format=pdf`) as never,
      args(created.generationJobId),
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="cv-v1.pdf"');
    const pdfBody = new Uint8Array(await pdf.arrayBuffer());
    const onDisk = await readFile(uploadsPath("generations", version.id, "cv.pdf"));
    expect(createHash("sha256").update(pdfBody).digest("hex")).toBe(
      createHash("sha256").update(onDisk).digest("hex"),
    );

    const docx = await download(
      new Request(`${BASE}/${created.generationJobId}/download?format=docx`) as never,
      args(created.generationJobId),
    );
    expect(docx.status).toBe(200);
    expect(docx.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(docx.headers.get("content-disposition")).toBe('attachment; filename="cv-v1.docx"');

    // plain text arrives with cover letters (US6) — explicit conflict for now
    const txt = await download(
      new Request(`${BASE}/${created.generationJobId}/download?format=txt`) as never,
      args(created.generationJobId),
    );
    expect(txt.status).toBe(409);
    expect((await txt.json()).error.code).toBe("GENERATION_INVALID_STATE");

  });
});

// --- US4: output language independent of the source, T039 ---

/** Digit tokens after normalizeText — the numeric-identity lens (identical for FR/EN). */
function digitTokens(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((t) => /\d/.test(t));
}

async function seedFrenchProfile() {
  const { createEntry } = await import("@/lib/profile/repository");
  const e1 = await createEntry(user.id, "experience", {
    company: "Banque Numérique",
    title: "Ingénieure Plateforme",
    startDate: "2021-01",
    endDate: "present",
    skillsUsed: ["Kubernetes"],
    bullets: [
      { text: "Exploitation de clusters Kubernetes servant 2M requêtes par jour.", order: 0 },
      { text: "Encadrement d'une équipe de 5 ingénieurs.", order: 1 },
    ],
  });
  const ed1 = await createEntry(user.id, "education", {
    institution: "Université de Montréal",
    degree: "BSc",
    field: "Informatique",
    startDate: "2012-09",
    endDate: "2016-05",
  });
  const c1 = await createEntry(user.id, "certifications", { title: "CKA", issuer: "CNCF", issueDate: "2023-04" });
  const s1 = await createEntry(user.id, "skills", { name: "Kubernetes" });
  const bullets = await db.bullet.findMany({ where: { experienceId: e1.id }, orderBy: { order: "asc" } });
  return { e1: e1.id, ed1: ed1.id, c1: c1.id, s1: s1.id, bullets };
}

type FrenchSeed = Awaited<ReturnType<typeof seedFrenchProfile>>;

/** A matched FR-language analysis (JD_FR) with evidence over the French profile. */
async function matchedFrenchAnalysis(seed: FrenchSeed): Promise<string> {
  const { analysis } = await createAnalysis(user.id, JD_FR);
  const profile = await getOrCreateProfile(user.id);
  await persistReport(
    user.id,
    analysis.id,
    profile.version,
    reportFixture({
      requirements: [
        {
          id: "r1",
          text: "Kubernetes",
          importance: "must",
          isHardConstraint: true,
          status: "strong",
          matchMethod: "exact",
          evidence: [
            { type: "skill", id: seed.s1, snippet: "Kubernetes" },
            { type: "bullet", id: seed.e1, snippet: "Ingénieure Plateforme — Banque Numérique" },
          ],
          note: null,
        },
      ],
      recommendedKeywords: ["Kubernetes", "Go"],
    }),
  );
  return analysis.id;
}

describe("US4: output language independent of the source", () => {
  it("FR profile + FR JD → explicit EN output: EN narrative/headings, verbatim proper nouns, identical numbers", async () => {
    const seed = await seedFrenchProfile();
    const analysisId = await matchedFrenchAnalysis(seed);
    const ids = {
      summary: "summary",
      e1b1: `exp.${seed.e1}.1`,
      e1b2: `exp.${seed.e1}.2`,
      edu: `edu.${seed.ed1}`,
      cert: `cert.${seed.c1}`,
    };
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: { plan?: Array<{ key: string; sourceText: string[] }>; claims?: Array<{ claimId: string }> } }) => {
      return Promise.resolve(
        mockLLM({
          summary: "Platform engineer with deep Kubernetes operations experience.",
          items: [
            { key: ids.e1b1, text: "Operated Kubernetes clusters serving 2M requests per day." },
            { key: ids.e1b2, text: "Led a team of 5 engineers." },
            // institution + certification names preserved verbatim (FR-015)
            { key: ids.edu, text: "BSc · Computer Science · Université de Montréal" },
            { key: ids.cert, text: "CKA · CNCF" },
            // feature 005: echo the title keys (rewritten per language in the UI contract)
            ...(payload.plan ?? [])
              .filter((i) => i.key.startsWith("expTitle."))
              .map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
          ],
        }),
      );
    }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { outputLanguage: "en" } }) as never,
    );
    expect(res.status).toBe(202);
    const created = await res.json();
    expect(created.settings).toMatchObject({ outputLanguage: "en" }); // explicit override of the fr default

    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");

    // the draft received the output language, not the profile/JD language
    const draftPayload = vi.mocked(callLLM).mock.calls.find((c) => c[0].task === "generateTailoredCV")![0]
      .payload as { outputLanguage: string };
    expect(draftPayload.outputLanguage).toBe("en");

    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });
    const content = version.content as import("@/lib/generation/schemas").GeneratedCVContent;
    // all narrative in the output language
    expect(content.summary).toBe("Platform engineer with deep Kubernetes operations experience.");
    expect(content.experience[0].bullets.map((b) => b.text)).toEqual([
      "Operated Kubernetes clusters serving 2M requests per day.",
      "Led a team of 5 engineers.",
    ]);
    // proper nouns verbatim
    expect(content.education[0].text).toContain("Université de Montréal");
    expect(content.certifications[0].text).toBe("CKA · CNCF");
    // numeric identity: every digit token in the EN claims exists in the FR source bullets
    const sourceDigits = new Set(seed.bullets.flatMap((b) => digitTokens(b.text)));
    for (const token of content.experience[0].bullets.flatMap((b) => digitTokens(b.text))) {
      expect(sourceDigits.has(token)).toBe(true);
    }

    const report = version.validationReport as ReportShape;
    expect(report.summary).toEqual({ blockers: 0, warnings: 0 }); // no NUMERIC_MISMATCH, no fallbacks
    expect(report.flags.some((f) => f.code === "NUMERIC_MISMATCH")).toBe(false);

    // EN headings rendered and gate-verified (settings-driven)
    const extraction = version.extractionCheck as {
      passed: boolean;
      level1: { elements: Array<{ element: string; expected: string; found: boolean }> };
    };
    expect(extraction.passed).toBe(true);
    expect(extraction.level1.elements).toContainEqual({ element: "heading:experience", expected: "Experience", found: true });
    expect(extraction.level1.elements).toContainEqual({ element: "heading:education", expected: "Education", found: true });
    expect(extraction.level1.elements.every((e) => e.expected !== "Expérience professionnelle")).toBe(true);
  });

  it("EN profile + EN JD → explicit FR output: FR narrative/headings, verbatim proper nouns, identical numbers, clean gates", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const ids = claimIds(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: { plan?: Array<{ key: string; sourceText: string[] }>; claims?: Array<{ claimId: string }> } }) => {
      return Promise.resolve(
        mockLLM({
          summary: "Ingénieure plateforme avec une expertise Kubernetes de 2M requêtes par jour.",
          items: [
            { key: ids.e1b1, text: "Exploitation de clusters Kubernetes servant 2M requêtes par jour." },
            { key: ids.e1b2, text: "Encadrement d'une équipe de 5 ingénieurs." },
            { key: ids.proj, text: "Création d'un vérificateur de conformité ATS utilisé par 400 utilisateurs." },
            // employer/institution verbatim even in FR narrative
            { key: ids.edu, text: "BSc · Informatique · McGill University" },
            { key: ids.cert, text: "CKA · CNCF" },
            // feature 005: echo the title keys (FR rewrites asserted below)
            ...(payload.plan ?? [])
              .filter((i) => i.key.startsWith("expTitle."))
              .map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
          ],
        }),
      );
    }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { outputLanguage: "fr" } }) as never,
    );
    const created = await res.json();
    expect(created.settings).toMatchObject({ outputLanguage: "fr" }); // explicit override of the en default

    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");

    const draftPayload = vi.mocked(callLLM).mock.calls.find((c) => c[0].task === "generateTailoredCV")![0]
      .payload as { outputLanguage: string };
    expect(draftPayload.outputLanguage).toBe("fr");

    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });
    const content = version.content as import("@/lib/generation/schemas").GeneratedCVContent;
    expect(content.summary).toBe("Ingénieure plateforme avec une expertise Kubernetes de 2M requêtes par jour.");
    expect(content.experience[0].bullets[0].text).toBe("Exploitation de clusters Kubernetes servant 2M requêtes par jour.");
    expect(content.education[0].text).toContain("McGill University"); // institution verbatim
    expect(content.certifications[0].text).toBe("CKA · CNCF");

    // numeric identity vs the EN profile bullets (2M, 5, 400 all carried across)
    const profileBullets = await db.bullet.findMany({ where: { experienceId: seed.e1 } });
    const sourceDigits = new Set(profileBullets.flatMap((b) => digitTokens(b.text)));
    for (const token of content.experience.flatMap((e) => e.bullets).flatMap((b) => digitTokens(b.text))) {
      expect(sourceDigits.has(token)).toBe(true);
    }

    const report = version.validationReport as ReportShape;
    expect(report.summary).toEqual({ blockers: 0, warnings: 0 });

    // FR headings rendered and gate-verified
    const extraction = version.extractionCheck as {
      passed: boolean;
      level1: { elements: Array<{ element: string; expected: string; found: boolean }> };
    };
    expect(extraction.passed).toBe(true);
    expect(extraction.level1.elements).toContainEqual({
      element: "heading:experience",
      expected: "Expérience professionnelle",
      found: true,
    });
    expect(extraction.level1.elements).toContainEqual({ element: "heading:education", expected: "Formation", found: true });

    // the bilingual deliverable is fully gate-verified and downloadable
    const { GET: poll } = await import("@/app/api/generations/[id]/route");
    const polled = await (await poll(null as never, args(created.generationJobId))).json();
    expect(polled.document.downloadable).toEqual({ pdf: true, docx: true, txt: false });
  });
});

// --- US5: inspect and reverse omissions, T042 ---

/** A weak 40-bullet old entry e1 (demotes whole at budget 1) + a strong current
 *  2-bullet entry e2 whose first bullet carries MatchReport evidence. */
async function seedOverflowingProfile() {
  const { createEntry } = await import("@/lib/profile/repository");
  const long =
    "Conception et livraison d'un composant critique avec des métriques de disponibilité mesurables, de la documentation exhaustive et une revue par les pairs systématique.";
  const e1 = await createEntry(user.id, "experience", {
    company: "Old Corp",
    title: "Engineer",
    startDate: "2005-01",
    endDate: "2009-12",
    bullets: Array.from({ length: 40 }, (_, i) => ({ text: `${long} (${i + 1})`, order: i })),
  });
  const e2 = await createEntry(user.id, "experience", {
    company: "Strong Corp",
    title: "Platform Engineer",
    startDate: "2020-01",
    endDate: "present",
    skillsUsed: ["Kubernetes"],
    bullets: [
      { text: "Operated Kubernetes clusters serving 2M requests per day.", order: 0 },
      { text: "Led a team of 5 engineers.", order: 1 },
    ],
  });
  const s1 = await createEntry(user.id, "skills", { name: "Kubernetes" });
  return { e1: e1.id, e2: e2.id, s1: s1.id };
}

type OverflowSeed = Awaited<ReturnType<typeof seedOverflowingProfile>>;

async function matchedOverflowAnalysis(seed: OverflowSeed): Promise<string> {
  const { analysis } = await createAnalysis(user.id, JD_EN);
  const profile = await getOrCreateProfile(user.id);
  await persistReport(
    user.id,
    analysis.id,
    profile.version,
    reportFixture({
      requirements: [
        {
          id: "r1",
          text: "Kubernetes",
          importance: "must",
          isHardConstraint: true,
          status: "strong",
          matchMethod: "exact",
          evidence: [
            { type: "skill", id: seed.s1, snippet: "Kubernetes" },
            { type: "bullet", id: seed.e2, snippet: "Platform Engineer — Strong Corp" },
          ],
          note: null,
        },
      ],
      recommendedKeywords: ["Kubernetes"],
    }),
  );
  return analysis.id;
}

/** Mocked LLM for omission scenarios: the premium draft echoes e2's bullets
 *  (all other keys fall back verbatim). */
function mockOmissionLLM(seed: OverflowSeed) {
  const e2b1 = `exp.${seed.e2}.1`;
  const e2b2 = `exp.${seed.e2}.2`;
  return async ({ task, payload }: { task: string; payload: { claims?: Array<{ claimId: string }> } }) => {
    return mockLLM({
      summary: "Platform engineer with deep Kubernetes operations experience.",
      items: [
        { key: e2b1, text: "Operated Kubernetes clusters serving 2M requests per day." },
        { key: e2b2, text: "Led a team of 5 engineers." },
      ],
    });
  };
}

/** Run one generation over the overflowing seed; returns the created job body. */
async function generateOverflowing(seed: OverflowSeed, analysisId: string, pageBudget: number) {
  const { callLLM } = await import("@/lib/llm/router");
  vi.mocked(callLLM).mockImplementation(mockOmissionLLM(seed) as never);
  const { POST } = await import("@/app/api/generations/route");
  const res = await POST(
    jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { pageBudget } }) as never,
  );
  const created = await res.json();
  const { runGenerationJob } = await import("@/lib/generation/pipeline");
  await runGenerationJob(created.generationJobId);
  return created;
}

type Omission = { type: string; id: string; reason: string; restoredMustInclude?: boolean };

async function restoreOmission(jobId: string, omissionId: string) {
  const { POST: restore } = await import(
    "@/app/api/generations/[id]/document/omissions/[omissionId]/restore/route"
  );
  return restore(null as never, { params: Promise.resolve({ id: jobId, omissionId }) });
}

describe("US5: inspect and reverse omissions", () => {
  it("restore marks restoredMustInclude on the current version's omission (200 {omissions}); 404 OMISSION_NOT_FOUND otherwise", async () => {
    const seed = await seedOverflowingProfile();
    const analysisId = await matchedOverflowAnalysis(seed);
    const created = await generateOverflowing(seed, analysisId, 1);

    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });
    const content = version.content as { omissions: Omission[] };
    // tight budget produced a page_budget omission with type, identifier, reason
    expect(content.omissions).toEqual([{ type: "experience", id: seed.e1, reason: "page_budget" }]);

    const restored = await restoreOmission(created.generationJobId, seed.e1);
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { omissions: Omission[] };
    expect(body.omissions).toEqual([
      { type: "experience", id: seed.e1, reason: "page_budget", restoredMustInclude: true },
    ]);

    // persisted on the current version's content
    const after = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });
    expect((after.content as { omissions: Omission[] }).omissions[0].restoredMustInclude).toBe(true);

    // unknown omission id → 404 OMISSION_NOT_FOUND
    const unknown = await restoreOmission(created.generationJobId, "no-such-omission");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("OMISSION_NOT_FOUND");
    expect((await restoreOmission("missing-job", seed.e1)).status).toBe(404);
  });

  it("restored item is consumed by the next regeneration: present in content, absent from the new omissions", async () => {
    const seed = await seedOverflowingProfile();
    const analysisId = await matchedOverflowAnalysis(seed);
    const first = await generateOverflowing(seed, analysisId, 1); // v1 demotes e1

    const restored = await restoreOmission(first.generationJobId, seed.e1);
    expect(restored.status).toBe(200);

    // regenerate at a budget the restored entry fits (2 pages) → e1 is back
    const second = await generateOverflowing(seed, analysisId, 2);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: second.generationJobId } });
    expect(job.status).toBe("succeeded");

    const versions = await db.generatedDocumentVersion.findMany({
      where: { documentId: first.documentId },
      orderBy: { version: "asc" },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2]); // FR-018 version chain

    const v2 = versions[1].content as import("@/lib/generation/schemas").GeneratedCVContent;
    const entry = v2.experience.find((e) => e.id === seed.e1);
    expect(entry).toBeDefined(); // consumed into content
    expect(entry!.bullets).toHaveLength(40);
    expect(v2.omissions).toEqual([]); // absent from the new omissions — never silently re-omitted
    expect((versions[1].extractionCheck as { passed: boolean }).passed).toBe(true);
  });

  it("over-restoring beyond the budget fails the job PAGE_BUDGET_CONFLICT with actionable guidance (SC-006), never silent re-omission", async () => {
    const seed = await seedOverflowingProfile();
    const analysisId = await matchedOverflowAnalysis(seed);
    const first = await generateOverflowing(seed, analysisId, 1); // v1 demotes e1

    const restored = await restoreOmission(first.generationJobId, seed.e1);
    expect(restored.status).toBe(200);

    // regenerate at the same tight budget: the must-include set cannot fit
    const second = await generateOverflowing(seed, analysisId, 1);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: second.generationJobId } });
    expect(job.status).toBe("failed");
    expect(job.statusError).toContain("PAGE_BUDGET_CONFLICT");
    expect(job.statusError).toContain("page budget"); // actionable guidance, not a bare code

    // the conflict surfaces through the polling endpoint (the UI conflict state)
    const { GET: poll } = await import("@/app/api/generations/[id]/route");
    const polled = await (await poll(null as never, args(second.generationJobId))).json();
    expect(polled.job.statusError).toContain("PAGE_BUDGET_CONFLICT");

    // nothing silently re-omitted: no new version was produced
    const versions = await db.generatedDocumentVersion.findMany({ where: { documentId: first.documentId } });
    expect(versions).toHaveLength(1); // v1 only — the failed job appended nothing
    expect((versions[0].content as { omissions: Omission[] }).omissions[0].restoredMustInclude).toBe(true);
  });

  it("a fits-everything generation exposes a present-but-empty omissions list (no hidden truncation)", async () => {
    const seed = await seedGenerationProfile(); // small profile — everything fits
    const created = await setupCleanExport(seed);

    const { GET } = await import("@/app/api/generations/[id]/document/route");
    const res = await GET(null as never, args(created.generationJobId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.omissions).toEqual([]); // present, empty
    expect(body.content.omissions).toEqual([]);
  });
});

// --- US4 (feature 005): omissions completeness across every section ---

/** Sections exceeding their caps at budget 2 — 5 experiences (cap 4), 3 projects
 *  (cap 2), 4 education (cap 3), 4 certifications (cap 3). Every entry is light
 *  (one short bullet) so the 2-page budget never demotes: the ONLY omissions
 *  come from the selection cut, which is what SC-001 asserts. */
async function seedOverCapsProfile() {
  const { createEntry } = await import("@/lib/profile/repository");
  const light = "Delivered a cross-team initiative with measurable outcomes.";
  const ids = { experience: [] as string[], projects: [] as string[], education: [] as string[], certifications: [] as string[] };
  const starts = ["2024-01", "2022-01", "2020-01", "2016-01", "2012-01"];
  for (let i = 0; i < 5; i++) {
    const e = await createEntry(user.id, "experience", {
      company: `Corp ${i + 1}`,
      title: "Engineer",
      startDate: starts[i]!,
      endDate: i === 0 ? "present" : `${starts[i]!.slice(0, 4)}-06`,
      bullets: [{ text: light, order: 0 }],
    });
    ids.experience.push(e.id);
  }
  for (let i = 0; i < 3; i++) {
    const p = await createEntry(user.id, "projects", {
      name: `Project ${i + 1}`,
      bullets: [{ text: light, order: 0 }],
    });
    ids.projects.push(p.id);
  }
  for (let i = 0; i < 4; i++) {
    const ed = await createEntry(user.id, "education", {
      institution: `School ${i + 1}`,
      degree: "BSc",
      field: "Computer Science",
      startDate: null,
      endDate: "2012-05", // identical across entries — ties break by snapshot order (SC-002)
    });
    ids.education.push(ed.id);
  }
  for (let i = 0; i < 4; i++) {
    const c = await createEntry(user.id, "certifications", { title: `Cert ${i + 1}`, issuer: "CNCF", issueDate: "2023-04" });
    ids.certifications.push(c.id);
  }
  return ids;
}

/** Echoes every plan item verbatim and supports every claim — the completeness
 *  assertions below stay about the plan's cut, not the mock's choices. */
function mockEchoLLM() {
  return (({ task, payload }: { task: string; payload: { plan?: Array<{ key: string; sourceText: string[] }>; claims?: Array<{ claimId: string }> } }) => {
    return Promise.resolve(
      mockLLM({
        summary: "Platform engineer delivering measurable cross-team outcomes.",
        items: (payload.plan ?? []).map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
      }),
    );
  }) as never;
}

describe("US4: omissions completeness (feature 005)", () => {
  it("every profile entry is in the draft OR the omissions list — unselected entries carry reason selection across ALL sections (SC-001/SC-007)", async () => {
    const ids = await seedOverCapsProfile();
    const { analysis } = await createAnalysis(user.id, JD_EN);
    const profile = await getOrCreateProfile(user.id);
    await persistReport(user.id, analysis.id, profile.version, reportFixture({ recommendedKeywords: ["Kubernetes"] }));
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation(mockEchoLLM());

    const { POST } = await import("@/app/api/generations/route");
    const created = await (await POST(jsonReq(BASE, "POST", { analysisId: analysis.id, kind: "cv" }) as never)).json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");

    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });
    const content = version.content as import("@/lib/generation/schemas").GeneratedCVContent;

    // the union of drafted entries + omitted ids covers EVERY profile entry,
    // per section, and the omissions list is selection-only in this fixture
    expect(content.omissions.every((o) => o.reason === "selection")).toBe(true); // light profile — nothing hit the budget
    const omitted = new Set(content.omissions.map((o) => `${o.type}:${o.id}`));
    const cover = (drafted: string[], all: string[], type: string) => {
      for (const id of all) {
        const isDrafted = drafted.includes(id);
        const isOmitted = omitted.has(`${type}:${id}`);
        expect({ id, isDrafted, isOmitted }).toEqual({ id, isDrafted: !isOmitted, isOmitted: !isDrafted }); // exactly one of the two
      }
    };
    cover(content.experience.map((e) => e.id), ids.experience, "experience");
    expect(content.experience).toHaveLength(4); // cap 4 at budget 2
    cover(content.projects.map((p) => p.id), ids.projects, "project");
    expect(content.projects).toHaveLength(2); // cap 2
    cover(content.education.map((e) => e.id), ids.education, "education");
    expect(content.education).toHaveLength(3); // cap 3
    cover(content.certifications.map((c) => c.id), ids.certifications, "certification");
    expect(content.certifications).toHaveLength(3); // cap 3
    expect(content.omissions).toEqual([
      { type: "experience", id: ids.experience[4]!, reason: "selection" },
      { type: "project", id: ids.projects[2]!, reason: "selection" },
      { type: "education", id: ids.education[3]!, reason: "selection" },
      { type: "certification", id: ids.certifications[3]!, reason: "selection" },
    ]);
  });

  it("restoring a selection omission makes it must-include in the next generation (consumed, cap-free)", async () => {
    const ids = await seedOverCapsProfile();
    const { analysis } = await createAnalysis(user.id, JD_EN);
    const profile = await getOrCreateProfile(user.id);
    await persistReport(user.id, analysis.id, profile.version, reportFixture({ recommendedKeywords: ["Kubernetes"] }));
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation(mockEchoLLM());

    const { POST } = await import("@/app/api/generations/route");
    const first = await (await POST(jsonReq(BASE, "POST", { analysisId: analysis.id, kind: "cv" }) as never)).json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(first.generationJobId);

    const cutEntry = ids.experience[4]!; // the selection-omitted experience entry
    const restored = await restoreOmission(first.generationJobId, cutEntry);
    expect(restored.status).toBe(200);

    const second = await (
      await POST(jsonReq(BASE, "POST", { analysisId: analysis.id, kind: "cv" }) as never)
    ).json();
    await runGenerationJob(second.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: second.generationJobId } });
    expect(job.status).toBe("succeeded");

    const v2 = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: first.documentId },
      orderBy: { version: "desc" },
    });
    expect(v2.version).toBe(2);
    const content = v2.content as import("@/lib/generation/schemas").GeneratedCVContent;
    expect(content.experience.map((e) => e.id)).toContain(cutEntry); // restored entry drafted (4 cap slots + restored)
    expect(content.experience).toHaveLength(5);
    expect(content.omissions.map((o) => o.id)).not.toContain(cutEntry); // consumed — never silently re-omitted
    // the other sections' cuts are unchanged by the restore
    expect(content.omissions).toEqual([
      { type: "project", id: ids.projects[2]!, reason: "selection" },
      { type: "education", id: ids.education[3]!, reason: "selection" },
      { type: "certification", id: ids.certifications[3]!, reason: "selection" },
    ]);
  });
});

// --- Phase 8: the designed two-column template (selectable; ATS stays default) ---

describe("Phase 8: designed template + DE output", () => {
  it("templateId designed + outputLanguage de: frozen settings, designed render gate-verified end-to-end, DE headings in the artifact", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation(mockEchoLLM());

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(
      jsonReq(BASE, "POST", {
        analysisId,
        kind: "cv",
        settings: { templateId: "designed", outputLanguage: "de" },
      }) as never,
    );
    expect(res.status).toBe(202);
    const created = await res.json();
    expect(created.settings).toMatchObject({ templateId: "designed", outputLanguage: "de" });

    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");
    expect(job.settings).toMatchObject({ templateId: "designed", outputLanguage: "de" });

    // the premium task saw the de output language (SC: language applies to rewriting)
    const cvCall = vi
      .mocked(callLLM)
      .mock.calls.map((c) => c[0])
      .find((c) => (c as { task: string }).task === "generateTailoredCV") as { payload: { outputLanguage: string } };
    expect(cvCall.payload.outputLanguage).toBe("de");

    // the designed PDF passed the SAME extraction gate
    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: created.documentId },
      orderBy: { version: "desc" },
    });
    expect((version.extractionCheck as { passed: boolean }).passed).toBe(true);
    expect(SelectionRecordSchema.parse(version.selection).included.length).toBeGreaterThan(0); // selection unchanged

    type ArtifactRow = { format: string; storagePath: string; gate: string };
    const artifacts = version.artifacts as ArtifactRow[];
    expect(artifacts.map((a) => a.format).sort()).toEqual(["docx", "pdf"]);
    expect(artifacts.find((a) => a.format === "pdf")!.gate).toBe("verified");

    // the STORED pdf is the designed two-column render in German — the DE
    // heading map appears in its extracted text layer
    const { extractPdfPages } = await import("@/lib/parsing/pdf");
    const pdfPath = artifacts.find((a) => a.format === "pdf")!.storagePath;
    const pages = await extractPdfPages(new Uint8Array(await readFile(pdfPath)));
    const text = normalizeText(pages.map((p) => p.text).join("\n"));
    // this seed has no basics/languages — the sidebar skips those blocks (no
    // empty headings); Kontakt/Sprachen coverage lives in the unit suite
    for (const heading of ["Kurzprofil", "Berufserfahrung", "Ausbildung", "Fähigkeiten"]) {
      expect(text).toContain(normalizeText(heading));
    }
    // dynamic items rendered (no fixed slots): both bullets + the skill
    expect(text).toContain(normalizeText("Operated Kubernetes clusters serving 2M requests per day."));
    expect(text).toContain(normalizeText("Kubernetes"));
  });

  it("the ATS single-column template remains the default when templateId is absent", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation(mockEchoLLM());

    const { POST } = await import("@/app/api/generations/route");
    const created = await (
      await POST(jsonReq(BASE, "POST", { analysisId, kind: "cv" }) as never)
    ).json();
    expect(created.settings.templateId).toBe("ats");
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded"); // unchanged ATS pipeline
  });
});

// --- Feature 006 US4: the FR/EN/DE x ATS/designed download matrix (SC-004) ---

describe("US4: dual-template export matrix (feature 006)", () => {
  /** One accented profile reused by every matrix cell: employers carry é and ü
   *  so accent survival is asserted through snapshot-verbatim rendering. */
  async function seedAccentedProfile() {
    const { createEntry } = await import("@/lib/profile/repository");
    const e1 = await createEntry(user.id, "experience", {
      company: "Café Analytics",
      title: "Platform Engineer",
      startDate: "2022-01",
      endDate: "present",
      skillsUsed: ["Kubernetes"],
      bullets: [{ text: "Operated Kubernetes clusters serving 2M requests per day.", order: 0 }],
    });
    const e2 = await createEntry(user.id, "experience", {
      company: "Müller Systems",
      title: "Backend Developer",
      startDate: "2019-06",
      endDate: "2021-12",
      bullets: [{ text: "Built Kafka ingestion handling 40k events per minute.", order: 0 }],
    });
    const s1 = await createEntry(user.id, "skills", { name: "Kubernetes" });
    const ed1 = await createEntry(user.id, "education", {
      institution: "Université de Lyon",
      degree: "MSc",
      field: "Computer Science",
      startDate: "2014-09",
      endDate: "2016-05",
    });
    return { e1: e1.id, e2: e2.id, s1: s1.id, ed1: ed1.id };
  }

  for (const templateId of ["ats", "designed"] as const) {
    for (const outputLanguage of ["en", "fr", "de"] as const) {
      it(`matrix ${templateId} x ${outputLanguage}: verified PDF + template-marker DOCX + accents intact`, async () => {
        const seed = await seedAccentedProfile();
        const { analysis } = await createAnalysis(user.id, JD_EN);
        const profile = await getOrCreateProfile(user.id);
        await persistReport(
          user.id,
          analysis.id,
          profile.version,
          reportFixture({
            requirements: [
              {
                id: "r1",
                text: "Kubernetes",
                importance: "must",
                isHardConstraint: true,
                status: "strong",
                matchMethod: "exact",
                evidence: [
                  { type: "skill", id: seed.s1, snippet: "Kubernetes" },
                  { type: "bullet", id: seed.e1, snippet: "Platform Engineer — Café Analytics" },
                ],
                note: null,
              },
            ],
            recommendedKeywords: ["Kubernetes"],
          }),
        );
        const { callLLM } = await import("@/lib/llm/router");
        vi.mocked(callLLM).mockImplementation(mockEchoLLM());

        const { POST } = await import("@/app/api/generations/route");
        const created = await (
          await POST(
            jsonReq(BASE, "POST", {
              analysisId: analysis.id,
              kind: "cv",
              settings: { templateId, outputLanguage },
            }) as never,
          )
        ).json();
        const { runGenerationJob } = await import("@/lib/generation/pipeline");
        await runGenerationJob(created.generationJobId);
        const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
        expect(job.status).toBe("succeeded");

        // gate-verified PDF artifact
        const version = await db.generatedDocumentVersion.findFirstOrThrow({
          where: { documentId: created.documentId },
          orderBy: { version: "desc" },
        });
        expect((version.extractionCheck as { passed: boolean }).passed).toBe(true);
        const artifacts = version.artifacts as Array<{ format: string; storagePath: string; gate: string }>;
        expect(artifacts.find((a) => a.format === "pdf")!.gate).toBe("verified");

        // localized headings + verbatim accented employers in the PDF text layer
        const { extractPdfPages } = await import("@/lib/parsing/pdf");
        const pdfPath = artifacts.find((a) => a.format === "pdf")!.storagePath;
        const pages = await extractPdfPages(new Uint8Array(await readFile(pdfPath)));
        const text = normalizeText(pages.map((p) => p.text).join("\n"));
        const headingsByLanguage = {
          en: ["Professional Summary", "Experience", "Education"],
          fr: ["Résumé professionnel", "Expérience professionnelle", "Formation"],
          de: ["Kurzprofil", "Berufserfahrung", "Ausbildung"],
        } as const;
        for (const heading of headingsByLanguage[outputLanguage]) {
          expect(text).toContain(normalizeText(heading));
        }
        // accents survive in every template: é and ü employers render verbatim
        expect(text).toContain(normalizeText("Café Analytics"));
        expect(text).toContain(normalizeText("Müller Systems"));

        // the DOCX carries THIS template's markers (downloaded-bytes parity)
        const docxPath = artifacts.find((a) => a.format === "docx")!.storagePath;
        const { execFileSync } = await import("node:child_process");
        const xml = execFileSync(
          "python3",
          [
            "-c",
            "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);" +
              "print(z.read('word/document.xml').decode('utf-8'));",
            docxPath,
          ],
          { encoding: "utf8" },
        );
        if (templateId === "designed") {
          expect(xml).toContain('<w:gridCol w:w="3663"/>');
          expect(xml).toContain('w:fill="E8F0F8"');
        } else {
          expect(xml).not.toContain("<w:tbl>");
        }
      });
    }
  }
});

// --- US6: cover letter (kind = cover_letter on the same pipeline) ---

/** Letter paragraphs keyed to the deterministic angles; evidence comes from the
 *  plan (motivation/fit/achievement) — the merge keeps it verbatim. */
async function mockLetterLLM(paragraphTexts: string[], seed: Seed) {
  const { callLLM } = await import("@/lib/llm/router");
  vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: { plan?: Array<{ key: string; sourceText: string[] }>; claims?: Array<{ claimId: string }> } }) => {
    if (task === "generateCoverLetter") {
      return Promise.resolve(
        mockLLM({
          paragraphs: paragraphTexts.map((text, i) => ({ key: `letter.${i + 1}`, text })),
          uncertainTranslations: [],
        }),
      );
    }
    // CV task (if a cv was generated first in this test)
    return Promise.resolve(
      mockLLM({
        summary: "Platform engineer with Kubernetes operations experience.",
        items: [{ key: `exp.${seed.e1}.1`, text: "Operated Kubernetes clusters serving 2M requests per day." }],
      }),
    );
  }) as never);
}

async function createLetterGen(analysisId: string, settings: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/generations/route");
  const res = await POST(
    jsonReq(BASE, "POST", { analysisId, kind: "cover_letter", ...(Object.keys(settings).length ? { settings } : {}) }) as never,
  );
  return { res, body: await res.json() };
}

async function runLetterJob(generationJobId: string) {
  const { runGenerationJob } = await import("@/lib/generation/pipeline");
  await runGenerationJob(generationJobId);
  return db.generationJob.findUniqueOrThrow({ where: { id: generationJobId } });
}

describe("US6: complementary cover letter", () => {
  const LETTER_PARAGRAPHS = [
    "Dear Hiring Manager, I am writing to express my strong interest in the platform role.",
    "My background operating large Kubernetes clusters aligns directly with your requirements.",
    "I would welcome the opportunity to discuss how my experience can support your team.",
  ];

  it("letter job: fixed 1-page budget and professional tone defaults; full pipeline with claim ids letter.{n} and evidence", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    await mockLetterLLM(LETTER_PARAGRAPHS, seed);

    const { res, body } = await createLetterGen(analysisId, { pageBudget: 3 }); // budget is forced to 1
    expect(res.status).toBe(202);
    expect(body.settings).toMatchObject({ pageBudget: 1, tone: "professional", outputLanguage: "en" });

    const job = await runLetterJob(body.generationJobId);
    expect(job.status).toBe("succeeded");
    expect(job.statusError).toBeNull();

    const document = await db.generatedDocument.findUniqueOrThrow({
      where: { analysisId_kind: { analysisId, kind: "cover_letter" } },
    });
    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: document.id },
      orderBy: { version: "desc" },
    });
    const content = version.content as {
      paragraphs: Array<{ claimId: string; text: string; evidence: Array<{ id: string }> }>;
      tone: string;
    };
    expect(content.tone).toBe("professional");
    expect(content.paragraphs.map((p) => p.claimId)).toEqual(["letter.1", "letter.2", "letter.3"]);
    expect(content.paragraphs[0].text).toBe(LETTER_PARAGRAPHS[0]);
    expect(content.paragraphs.every((p) => p.evidence.length > 0)).toBe(true);

    // artifacts: pdf (gate-verified) + txt (plain text) — no docx for letters
    const artifacts = version.artifacts as Array<{ format: string; gate: string }>;
    expect(artifacts.map((a) => a.format).sort()).toEqual(["pdf", "txt"]);
    const extraction = version.extractionCheck as { passed: boolean };
    expect(extraction.passed).toBe(true);
  });

  it("download?format=txt serves the plain-text letter; pdf served too", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    await mockLetterLLM(LETTER_PARAGRAPHS, seed);
    const { body } = await createLetterGen(analysisId);
    const job = await runLetterJob(body.generationJobId);
    expect(job.status).toBe("succeeded");

    const { GET } = await import("@/app/api/generations/[id]/download/route");
    const txtReq = new Request(`${BASE}/${body.generationJobId}/download?format=txt`, { method: "GET" });
    const txtRes = await (GET as never as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>)(
      txtReq,
      args(body.generationJobId),
    );
    expect(txtRes.status).toBe(200);
    expect(txtRes.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(txtRes.headers.get("Content-Disposition")).toBe(`attachment; filename="letter-v1.txt"`);
    const text = await txtRes.text();
    expect(text).toContain(LETTER_PARAGRAPHS[0]);

    const pdfReq = new Request(`${BASE}/${body.generationJobId}/download?format=pdf`, { method: "GET" });
    const pdfRes = await (GET as never as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>)(
      pdfReq,
      args(body.generationJobId),
    );
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("Content-Type")).toBe("application/pdf");
  });

});

// --- US2 (feature 005): rewritten role titles end-to-end ---

describe("US2: rewritten role titles (feature 005)", () => {
  it("generation persists experience[].title with sourceTitle; FR output rewrites the title", async () => {
    const seed = await seedGenerationProfile();
    const analysisId = await matchedAnalysisWithEvidence(seed);
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockImplementation((({ task, payload }: { task: string; payload: {
      plan?: Array<{ key: string; sourceText: string[] }>;
      claims?: Array<{ claimId: string }>;
    } }) => {
      // rewrite every keyed item — the title key gets a French rewrite with the
      // employer name NOT in the title (titles never carry employers)
      return Promise.resolve(
        mockLLM({
          summary: "Platform engineer with Kubernetes operations experience.",
          items: (payload.plan ?? []).map((i) => ({
            key: i.key,
            text: i.key.startsWith("expTitle.")
              ? "Ingénieur plateforme — focus Kubernetes"
              : i.sourceText.join(" "),
          })),
        }),
      );
    }) as never);

    const { POST } = await import("@/app/api/generations/route");
    const res = await POST(
      jsonReq(BASE, "POST", { analysisId, kind: "cv", settings: { outputLanguage: "fr" } }) as never,
    );
    const created = await res.json();
    const { runGenerationJob } = await import("@/lib/generation/pipeline");
    await runGenerationJob(created.generationJobId);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: created.generationJobId } });
    expect(job.status).toBe("succeeded");

    const document = await db.generatedDocument.findUniqueOrThrow({
      where: { analysisId_kind: { analysisId, kind: "cv" } },
    });
    const version = await db.generatedDocumentVersion.findFirstOrThrow({
      where: { documentId: document.id },
      orderBy: { version: "desc" },
    });
    const content = version.content as import("@/lib/generation/schemas").GeneratedCVContent;
    const entry = content.experience.find((e) => e.id === seed.e1)!;
    expect(entry.title).toMatchObject({
      claimId: `expTitle.${seed.e1}`,
      text: "Ingénieur plateforme — focus Kubernetes",
      sourceTitle: "Platform Engineer",
    });

    expect(entry.title!.sourceTitle).toBe("Platform Engineer");
  });
});
