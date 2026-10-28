import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetAuth, signIn, signOut, type SessionUser } from "../support/auth";

/**
 * Ownership-scoping contract tests (specs/008, US2 / contracts/data-access-rules.md).
 * Exercised at the API boundary (route handlers), so they pin the CONTRACT —
 * cross-account access behaves as NOT_FOUND, listings exclude other users, and
 * quarantined (userId null) rows are invisible to everyone — independent of the
 * internal lib signatures that implement it.
 */
const BASE = "http://localhost:3000/api";

function jsonReq(path: string, method = "GET", body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const JD = `Senior Backend Engineer role. We require strong experience in distributed systems and Kubernetes.
You must have at least 5 years of Go development. A Bachelor's degree in Computer Science is required.
Nice to have: Kafka, Terraform. French language skills are a plus for our Montreal office.`;

let alice: SessionUser;

beforeEach(async () => {
  await db.jobRequirement.deleteMany({});
  await db.generatedDocumentVersion.deleteMany({});
  await db.generatedDocument.deleteMany({});
  await db.generationJob.deleteMany({});
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
  await resetAuth();
  alice = await signIn("alice-isolation@example.com");
  await signOut();
  await signIn("bob-isolation@example.com"); // account only — tests re-sign-in by email
});

async function createAnalysis(): Promise<string> {
  const { POST } = await import("@/app/api/jobs/route");
  const res = await POST(jsonReq("/jobs", "POST", { text: JD }) as never);
  expect(res.status).toBe(201);
  return (await res.json()).analysisId as string;
}

describe("job analyses are scoped to their owner", () => {
  it("stamps created analyses with the creating user", async () => {
    await signOut();
    await signIn("alice-isolation@example.com");
    const analysisId = await createAnalysis();
    const row = await db.jobAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(row.userId).toBe(alice.id);
  });

  it("hides another user's analysis from listings and direct access (NOT_FOUND)", async () => {
    await signOut();
    await signIn("alice-isolation@example.com");
    const analysisId = await createAnalysis();

    await signOut();
    await signIn("bob-isolation@example.com");
    const listRoute = await import("@/app/api/jobs/route");
    const list = await listRoute.GET();
    expect((await list.json()).analyses).toHaveLength(0);

    const { GET, PATCH, DELETE } = await import("@/app/api/jobs/[id]/route");
    const byId = await GET(jsonReq(`/jobs/${analysisId}`) as never, params(analysisId));
    expect(byId.status).toBe(404);
    expect((await byId.json()).error.code).toBe("NOT_FOUND");

    const patched = await PATCH(jsonReq(`/jobs/${analysisId}`, "PATCH", { language: "fr" }) as never, params(analysisId));
    expect(patched.status).toBe(404);
    const removed = await DELETE(jsonReq(`/jobs/${analysisId}`, "DELETE") as never, params(analysisId));
    expect(removed.status).toBe(404);
    // and it still exists, untouched, for the owner
    expect(await db.jobAnalysis.findUnique({ where: { id: analysisId } })).not.toBeNull();
  });

  it("treats quarantined (owner-less) legacy analyses as nonexistent for every user", async () => {
    const legacy = await db.jobAnalysis.create({
      data: { jdText: JD, language: "en", userId: null },
    });

    await signOut();
    await signIn("alice-isolation@example.com");
    const listRoute = await import("@/app/api/jobs/route");
    const list = await listRoute.GET();
    expect((await list.json()).analyses).toHaveLength(0); // legacy row not listed

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const byId = await GET(jsonReq(`/jobs/${legacy.id}`) as never, params(legacy.id));
    expect(byId.status).toBe(404);
  });

  it("owner keeps full access", async () => {
    await signOut();
    await signIn("alice-isolation@example.com");
    const analysisId = await createAnalysis();
    const { GET } = await import("@/app/api/jobs/[id]/route");
    const byId = await GET(jsonReq(`/jobs/${analysisId}`) as never, params(analysisId));
    expect(byId.status).toBe(200);
    expect((await byId.json()).analysis.id).toBe(analysisId);
  });
});

describe("source documents are scoped to their owner", () => {
  it("hides another user's uploaded CV (NOT_FOUND) and quarantined ones too", async () => {
    const aliceDoc = await db.sourceDocument.create({
      data: {
        userId: alice.id,
        originalFilename: "alice-cv.pdf",
        storagePath: "uploads-test/alice-cv.pdf",
        sha256: "a".repeat(64),
        mimeType: "application/pdf",
        sizeBytes: 1234,
        detectedLanguage: "en",
        extractedPages: [],
      },
    });
    const legacyDoc = await db.sourceDocument.create({
      data: {
        userId: null,
        originalFilename: "legacy-cv.pdf",
        storagePath: "uploads-test/legacy-cv.pdf",
        sha256: "b".repeat(64),
        mimeType: "application/pdf",
        sizeBytes: 5,
        detectedLanguage: "en",
        extractedPages: [],
      },
    });

    await signOut();
    await signIn("bob-isolation@example.com");
    const { PATCH } = await import("@/app/api/cv/[id]/route");
    for (const doc of [aliceDoc, legacyDoc]) {
      const res = await PATCH(
        jsonReq(`/cv/${doc.id}`, "PATCH", { language: "fr" }) as never,
        params(doc.id),
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    }

    await signOut();
    await signIn("alice-isolation@example.com");
    const { PATCH: ownerPatch } = await import("@/app/api/cv/[id]/route");
    const own = await ownerPatch(
      jsonReq(`/cv/${aliceDoc.id}`, "PATCH", { language: "en" }) as never,
      params(aliceDoc.id),
    );
    expect(own.status).toBe(200);
  });
});

describe("profiles are scoped to their owner", () => {
  it("never serves another user's profile", async () => {
    const aliceProfile = await db.profile.create({ data: { userId: alice.id, language: "en" } });

    await signOut();
    await signIn("bob-isolation@example.com");
    const { GET } = await import("@/app/api/profile/route");
    const res = await GET();
    const body = await res.json();
    if (res.status === 200 && body.profile) {
      expect(body.profile.id).not.toBe(aliceProfile.id); // B gets their own (possibly created) profile
    } else {
      expect(res.status).toBe(404); // or a clean not-found — never A's data
    }
  });

  it("quarantined legacy profiles are invisible to every signed-in user", async () => {
    const legacy = await db.profile.create({ data: { userId: null, language: "en" } });
    await signOut();
    await signIn("alice-isolation@example.com");
    const { GET } = await import("@/app/api/profile/route");
    const res = await GET();
    const body = await res.json();
    if (res.status === 200 && body.profile) expect(body.profile.id).not.toBe(legacy.id);
    else expect(res.status).toBe(404);
    expect(await db.profile.count({ where: { userId: null } })).toBe(1); // untouched
  });
});

describe("generation jobs are scoped through their analysis", () => {
  it("hides another user's generation job and quarantined ones (NOT_FOUND)", async () => {
    const analysis = await db.jobAnalysis.create({
      data: { userId: alice.id, jdText: JD, language: "en", status: "created" },
    });
    const job = await db.generationJob.create({
      data: {
        analysisId: analysis.id,
        kind: "cv",
        settings: {},
        profileVersion: 1,
        status: "succeeded",
      },
    });
    const legacyAnalysis = await db.jobAnalysis.create({
      data: { userId: null, jdText: JD, language: "en", status: "created" },
    });
    const legacyJob = await db.generationJob.create({
      data: {
        analysisId: legacyAnalysis.id,
        kind: "cover_letter",
        settings: {},
        profileVersion: 1,
        status: "succeeded",
      },
    });

    await signOut();
    await signIn("bob-isolation@example.com");
    const { GET } = await import("@/app/api/generations/[id]/route");
    for (const j of [job, legacyJob]) {
      const res = await GET(jsonReq(`/generations/${j.id}`) as never, params(j.id));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    }
  });
});
