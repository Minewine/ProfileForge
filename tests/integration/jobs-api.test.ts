import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { resetAuth, signIn } from "../support/auth";

vi.mock("@/lib/llm/router", () => ({
  callLLM: vi.fn(),
  registerTask: vi.fn(),
  resetTaskRegistry: vi.fn(),
  OPENROUTER_URL: "x",
}));

const BASE = "http://localhost:3000/api/jobs";

let user: Awaited<ReturnType<typeof signIn>>;

const JD_EN = `Senior Backend Engineer role. We require strong experience in distributed systems and Kubernetes.
You must have at least 5 years of Go development. A Bachelor's degree in Computer Science is required.
Nice to have: Kafka, Terraform. French language skills are a plus for our Montreal office.`;

const JD_FR = `Ingénieur logiciel senior. Vous devez maîtriser Kubernetes et Go (au moins 5 ans d'expérience).
Un diplôme universitaire en informatique est exigé. Atout : expérience avec Kafka et Terraform.
Vous participerez à la conception de notre plateforme de données, encadrerez une petite équipe
de développeurs et travaillerez avec les équipes produit sur les exigences fonctionnelles.
La maîtrise de l'anglais technique est nécessaire ; la connaissance du secteur financier est un plus.`;

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
}

async function createJd(text = JD_EN) {
  const { POST } = await import("@/app/api/jobs/route");
  const res = await POST(jsonReq(BASE, "POST", { text }) as never);
  return { res, body: await res.json() };
}

beforeEach(async () => {
  await resetAuth();
  user = await signIn("jobs-api@example.com");
  await clean();
  vi.mocked((await import("@/lib/llm/router")).callLLM).mockReset();
});

describe("POST/GET/PATCH/DELETE /api/jobs", () => {
  it("creates with language detection and length guards", async () => {
    const short = await createJd("too short");
    expect(short.res.status).toBe(400);
    expect(short.body.error.code).toBe("JD_TOO_SHORT");

    const fr = await createJd(JD_FR);
    expect(fr.res.status).toBe(201);
    expect(fr.body.language).toBe("fr");
    expect(fr.body.status).toBe("created");

    const en = await createJd();
    expect(en.body.language).toBe("en");

    const { GET } = await import("@/app/api/jobs/route");
    const list = await GET();
    const listed = await list.json();
    expect(listed.analyses).toHaveLength(2);
    expect(listed.analyses[0]).toMatchObject({ status: "created", requirementCount: 0 });
  });

  it("corrects language before match; deletes with cascade", async () => {
    const { body } = await createJd();
    const { PATCH, DELETE } = await import("@/app/api/jobs/[id]/route");
    const patched = await PATCH(jsonReq(`${BASE}/${body.analysisId}`, "PATCH", { language: "fr" }) as never, args(body.analysisId));
    expect(patched.status).toBe(200);

    const gone = await DELETE(null as never, args(body.analysisId));
    expect(gone.status).toBe(204);
    expect(await db.jobAnalysis.count()).toBe(0);
  });
});

describe("extract + requirements review", () => {
  it("extracts via the LLM, replaces on re-extract, and enforces full-list review", async () => {
    const { body } = await createJd();
    const id = body.analysisId;
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: {
        requirements: [
          { text: "Kubernetes", category: "tool", importance: "must", isHardConstraint: true },
          { text: "Kafka", category: "tool", importance: "nice", isHardConstraint: false },
        ],
      },
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      modelUsed: "test/model",
    });

    const extract = await import("@/app/api/jobs/[id]/extract/route");
    const e1 = await extract.POST(null as never, args(id));
    expect(e1.status).toBe(200);
    const e1body = await e1.json();
    expect(e1body.status).toBe("extracted");
    expect(e1body.requirements).toHaveLength(2);
    expect(e1body.replacedRequirements).toBe(false);

    // match before finalize → INVALID_STATE
    const matchRoute = await import("@/app/api/jobs/[id]/match/route");
    const early = await matchRoute.POST(null as never, args(id));
    expect(early.status).toBe(409);
    expect((await early.json()).error.code).toBe("INVALID_STATE");

    const e2 = await extract.POST(null as never, args(id));
    expect((await e2.json()).replacedRequirements).toBe(true);

    const reqRoute = await import("@/app/api/jobs/[id]/requirements/route");
    const put = await reqRoute.PUT(
      jsonReq(`${BASE}/${id}/requirements`, "PUT", {
        requirements: [
          { text: "Kubernetes", category: "tool", importance: "must", isHardConstraint: true },
          { text: "Rust", category: "skill", importance: "nice", isHardConstraint: false },
        ],
        finalize: true,
      }) as never,
      args(id),
    );
    expect(put.status).toBe(200);
    expect((await put.json()).status).toBe("finalized");

    // invalid category → VALIDATION_ERROR
    const bad = await reqRoute.PUT(
      jsonReq(`${BASE}/${id}/requirements`, "PUT", {
        requirements: [{ text: "X", category: "hobby", importance: "must", isHardConstraint: false }],
        finalize: false,
      }) as never,
      args(id),
    );
    expect(bad.status).toBe(400);
  });

  it("marks the analysis failed on LLM error and allows retry", async () => {
    const { body } = await createJd();
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockRejectedValueOnce(new ApiError("LLM_UNAVAILABLE", "provider down"));
    const extract = await import("@/app/api/jobs/[id]/extract/route");
    const failed = await extract.POST(null as never, args(body.analysisId));
    expect(failed.status).toBe(503);
    const row = await db.jobAnalysis.findUnique({ where: { id: body.analysisId } });
    expect(row?.status).toBe("failed");
    expect(row?.statusError).toContain("down");

    vi.mocked(callLLM).mockResolvedValue({
      data: { requirements: [] },
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      modelUsed: "test/model",
    });
    const retry = await extract.POST(null as never, args(body.analysisId));
    expect(retry.status).toBe(200);
  });
});

describe("match + confirm + rerun (US2/US3)", () => {
  async function seedProfile(): Promise<string> {
    const { createEntry } = await import("@/lib/profile/repository");
    await createEntry(user.id, "skills", { name: "Kubernetes", category: "DevOps" });
    await createEntry(user.id, "skills", { name: "Kafka", category: "Data" });
    await createEntry(user.id, "experience", {
      company: "Northwind",
      title: "Backend Engineer",
      startDate: "2020-01",
      endDate: "present",
      skillsUsed: ["Kubernetes"],
      bullets: [{ text: "Operated Kubernetes clusters in production" }],
    });
    const bullet = await db.bullet.findFirstOrThrow();
    return bullet.id;
  }

  async function readyAnalysis() {
    const { body } = await createJd();
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: {
        requirements: [
          { text: "Kubernetes", category: "tool", importance: "must", isHardConstraint: true },
          { text: "event-driven architecture", category: "skill", importance: "nice", isHardConstraint: false },
          { text: "Terraform", category: "tool", importance: "must", isHardConstraint: true },
        ],
      },
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      modelUsed: "test/model",
    });
    const extract = await import("@/app/api/jobs/[id]/extract/route");
    await extract.POST(null as never, args(body.analysisId));
    const reqRoute = await import("@/app/api/jobs/[id]/requirements/route");
    // no-op finalize with the extracted list intact: fetch then re-put
    const { GET } = await import("@/app/api/jobs/[id]/route");
    const current = await (await GET(null as never, args(body.analysisId))).json();
    await reqRoute.PUT(
      jsonReq(`${BASE}/${body.analysisId}/requirements`, "PUT", {
        requirements: current.analysis.requirements.map(
          (r: { text: string; category: string; importance: string; isHardConstraint: boolean }) => ({
            text: r.text,
            category: r.category,
            importance: r.importance,
            isHardConstraint: r.isHardConstraint,
          }),
        ),
        finalize: true,
      }) as never,
      args(body.analysisId),
    );
    return body.analysisId;
  }

  it("matches deterministically: exact hit, semantic validated, hard stays gap, score persisted", async () => {
    const bulletId = await seedProfile();
    const id = await readyAnalysis();
    const { callLLM } = await import("@/lib/llm/router");

    // semantic task mock: valid proposal citing the REAL bullet id
    vi.mocked(callLLM).mockImplementation(async ({ task }) => {
      expect(task).toBe("semanticProposals");
      return {
        data: {
          proposals: [
            { requirementIndex: 1, entryIds: [bulletId], rationale: "operated k8s" },
          ],
        },
        usage: { promptTokens: 5, completionTokens: 5, costUsd: 0.001 },
        modelUsed: "test/model",
      } as never;
    });

    const matchRoute = await import("@/app/api/jobs/[id]/match/route");
    const res = await matchRoute.POST(null as never, args(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    const report = body.report;
    expect(body.status).toBe("matched");
    expect(report.overallScore).toBeGreaterThanOrEqual(0);

    const byText = Object.fromEntries(report.requirements.map((m: { text: string }) => [m.text, m]));
    expect(byText.Kubernetes).toMatchObject({ status: "strong", matchMethod: "exact" });
    expect(byText["event-driven architecture"]).toMatchObject({ status: "strong", matchMethod: "semantic" });
    expect(byText.Terraform).toMatchObject({ status: "gap", matchMethod: "none" }); // hard: no semantic auto-match
    expect(body.profileVersion).toBeGreaterThanOrEqual(1);

    // match again without recompute → 409 nudging rerun
    const again = await matchRoute.POST(null as never, args(id));
    expect(again.status).toBe(409);

    // confirm the hard Terraform requirement WITHOUT recorded semantic evidence → 422
    const confirmRoute = await import("@/app/api/jobs/[id]/confirm/route");
    const reqRow = (await db.jobRequirement.findFirst({ where: { analysisId: id, text: "Terraform" } }))!;
    const refused = await confirmRoute.POST(
      jsonReq(`${BASE}/${id}/confirm`, "POST", { requirementId: reqRow.id }) as never,
      args(id),
    );
    expect(refused.status).toBe(400);
  });

  it("degrades to exact/alias-only with a notice when the semantic task fails (FR-014)", async () => {
    await seedProfile();
    const id = await readyAnalysis();
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockRejectedValue(new ApiError("LLM_UNAVAILABLE", "provider down"));

    const matchRoute = await import("@/app/api/jobs/[id]/match/route");
    const res = await matchRoute.POST(null as never, args(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notice).toBe("semantic-matching-unavailable");
    expect(body.report.scoreBreakdown.semanticMatches).toBe(0);
    expect(body.report.requirements.some((m: { status: string }) => m.status === "gap")).toBe(true);
  });

  it("reruns create a chained analysis and the old report stays unchanged", async () => {
    await seedProfile();
    const id = await readyAnalysis();
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: { proposals: [] },
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      modelUsed: "test/model",
    });
    const matchRoute = await import("@/app/api/jobs/[id]/match/route");
    await matchRoute.POST(null as never, args(id));
    const before = await db.jobAnalysis.findUnique({ where: { id } });

    const rerunRoute = await import("@/app/api/jobs/[id]/rerun/route");
    const rerunRes = await rerunRoute.POST(null as never, args(id));
    expect(rerunRes.status).toBe(201);
    const { analysisId: newId } = await rerunRes.json();

    const fresh = await db.jobAnalysis.findUnique({ where: { id: newId } });
    expect(fresh?.status).toBe("finalized");
    expect(fresh?.rerunOfId).toBe(id);
    const after = await db.jobAnalysis.findUnique({ where: { id } });
    expect(after?.matchReport).toEqual(before?.matchReport); // immutable
    expect(await db.jobRequirement.count({ where: { analysisId: newId } })).toBe(3);
  });
});
