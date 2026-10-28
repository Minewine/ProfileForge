import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetAuth, signIn, type SessionUser } from "../support/auth";

const BASE = "http://localhost:3000/api/profile";

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function cleanDb() {
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

async function getProfileDto() {
  const { GET } = await import("@/app/api/profile/route");
  const res = await GET();
  return (await res.json()) as {
    profile: {
      version: number;
      experience: Array<{ id: string; company: string; title?: string; provenance: string; reviewFlag: string | null }>;
      skills: Array<{ id: string; name: string; provenance?: string; reviewFlag?: string | null }>;
    };
    lowConfidenceCount: number;
    hasDraftAwaitingImport: boolean;
  };
}

let user: SessionUser;

beforeEach(async () => {
  await resetAuth();
  user = await signIn("profile-editor@example.com");
  await cleanDb();
});

describe("GET/PATCH /api/profile", () => {
  it("returns the profile DTO with flag count and draft status", async () => {
    const dto = await getProfileDto();
    expect(dto.profile.version).toBeGreaterThanOrEqual(1);
    expect(dto.lowConfidenceCount).toBe(0);
    expect(dto.hasDraftAwaitingImport).toBe(false);
  });

  it("updates basics and language (language correction, FR-030)", async () => {
    const { PATCH } = await import("@/app/api/profile/route");
    const res = await PATCH(
      jsonReq(BASE, "PATCH", {
        language: "fr",
        basics: {
          name: "Camille Durand",
          email: "camille@example.fr",
          links: [],
        },
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBeGreaterThan(1);
    const dto = await getProfileDto();
    expect(dto.profile.version).toBe(body.version);
    const row = await db.profile.findFirst();
    expect(row?.language).toBe("fr");
    expect((row?.basics as { name?: string })?.name).toBe("Camille Durand");
  });
});

describe("entries API (all sections, autosave semantics)", () => {
  it("creates, patches (idempotent retry safe), and deletes an experience entry with bullets", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const { PATCH, DELETE } = await import("@/app/api/profile/entries/[section]/[id]/route");

    const createRes = await POST(
      jsonReq(`${BASE}/entries/experience`, "POST", {
        company: "Northwind",
        title: "Engineer",
        startDate: "2021-01",
        endDate: "present",
        bullets: [{ text: "Did things well" }],
      }) as never,
      { params: Promise.resolve({ section: "experience" }) },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; version: number; warnings: unknown[] };
    expect(created.id).toBeTruthy();

    // autosave-style PATCH: same body twice is safe (same end state, version bumps)
    const patchBody = { title: "Senior Engineer", bullets: [{ text: "Did things well" }, { text: "Led team of 4" }] };
    const p1 = await PATCH(
      jsonReq(`${BASE}/entries/experience/${created.id}`, "PATCH", patchBody) as never,
      { params: Promise.resolve({ section: "experience", id: created.id }) },
    );
    const p2 = await PATCH(
      jsonReq(`${BASE}/entries/experience/${created.id}`, "PATCH", patchBody) as never,
      { params: Promise.resolve({ section: "experience", id: created.id }) },
    );
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    const dto = await getProfileDto();
    const exp = dto.profile.experience.find((e) => e.id === created.id)!;
    expect(exp.title).toBe("Senior Engineer");

    const del = await DELETE(
      null as never,
      { params: Promise.resolve({ section: "experience", id: created.id }) },
    );
    expect(del.status).toBe(200);
    expect((await getProfileDto()).profile.experience).toHaveLength(0);
  });

  it("rejects duplicate skills with 409 + existingId and unknown sections with 404", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const first = await POST(
      jsonReq(`${BASE}/entries/skills`, "POST", { name: "Kubernetes" }) as never,
      { params: Promise.resolve({ section: "skills" }) },
    );
    expect(first.status).toBe(201);

    const dup = await POST(
      jsonReq(`${BASE}/entries/skills`, "POST", { name: "kubernètes" }) as never,
      { params: Promise.resolve({ section: "skills" }) },
    );
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as { error: { code: string; details: { existingId: string } } };
    expect(dupBody.error.code).toBe("DUPLICATE_SKILL");
    expect(dupBody.error.details.existingId).toBeTruthy();

    const badSection = await POST(
      jsonReq(`${BASE}/entries/hobbies`, "POST", { name: "x" }) as never,
      { params: Promise.resolve({ section: "hobbies" }) },
    );
    expect(badSection.status).toBe(404);
  });

  it("enforces provenance transitions via the API", async () => {
    // imported entries come from the import path, not the public create API
    // (which always creates user_entered entries — FR-005)
    const doc = await db.sourceDocument.create({
      data: {
        userId: user.id,
        originalFilename: "t.pdf",
        storagePath: "/tmp/t.pdf",
        sha256: `h-${Math.random().toString(36).slice(2)}`,
        mimeType: "application/pdf",
        sizeBytes: 1,
        detectedLanguage: "en",
        extractedPages: [],
      },
    });
    const { importFromDraft } = await import("@/lib/profile/repository");
    await importFromDraft(
      user.id,
      doc.id,
      "en",
      {
        experience: [],
        education: [],
        skills: [
          {
            name: "Go",
            provenance: "imported",
            sourceDocumentId: doc.id,
            sourceLocator: { page: 2 },
            reviewFlag: "low_confidence",
          },
          { name: "Python", provenance: "imported", sourceDocumentId: doc.id, sourceLocator: { page: 3 } },
        ],
        languages: [],
        projects: [],
        certifications: [],
      },
      "replace_parsed",
    );
    const { skills } = (await getProfileDto()).profile;
    const flagged = skills.find((s) => s.name === "Go")!;
    const clean = skills.find((s) => s.name === "Python")!;

    const { PATCH } = await import("@/app/api/profile/entries/[section]/[id]/route");
    const confirmed = await PATCH(
      jsonReq(`${BASE}/entries/skills/${flagged.id}`, "PATCH", { provenance: "user_confirmed" }) as never,
      { params: Promise.resolve({ section: "skills", id: flagged.id }) },
    );
    expect(confirmed.status).toBe(200);
    const skill = (await getProfileDto()).profile.skills.find((s) => s.id === flagged.id)!;
    expect(skill.provenance).toBe("user_confirmed");

    // confirming an imported entry WITHOUT an open review flag must be rejected
    const second = await PATCH(
      jsonReq(`${BASE}/entries/skills/${clean.id}`, "PATCH", { provenance: "user_confirmed" }) as never,
      { params: Promise.resolve({ section: "skills", id: clean.id }) },
    );
    expect(second.status).toBe(400);
  });

  it("validates request bodies with zod and returns VALIDATION_ERROR 400", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const res = await POST(
      jsonReq(`${BASE}/entries/experience`, "POST", { company: "" }) as never,
      { params: Promise.resolve({ section: "experience" }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("versions API", () => {
  it("lists versions and restores one", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    await POST(
      jsonReq(`${BASE}/entries/skills`, "POST", { name: "Rust" }) as never,
      { params: Promise.resolve({ section: "skills" }) },
    );
    const before = await getProfileDto();
    const skillId = before.profile.skills[0].id;

    const { DELETE } = await import("@/app/api/profile/entries/[section]/[id]/route");
    await DELETE(null as never, { params: Promise.resolve({ section: "skills", id: skillId }) });
    expect((await getProfileDto()).profile.skills).toHaveLength(0);

    const { GET } = await import("@/app/api/profile/versions/route");
    const listRes = await GET();
    const list = (await listRes.json()) as { versions: Array<{ version: number; cause: string }> };
    expect(list.versions.length).toBeGreaterThanOrEqual(2); // one snapshot per mutation
    const target = list.versions.find((v) => v.cause === "edit" && v.version === before.profile.version)!;

    const { POST: restore } = await import("@/app/api/profile/versions/[version]/restore/route");
    const restored = await restore(
      null as never,
      { params: Promise.resolve({ version: String(target.version) }) },
    );
    expect(restored.status).toBe(200);
    expect((await getProfileDto()).profile.skills.map((s) => s.name)).toEqual(["Rust"]);
  });
});

describe("strict partial patch semantics (spec 007)", () => {
  type BulletDto = { id: string; text: string; order: number };

  async function createExperienceWithBullets() {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const res = await POST(
      jsonReq(`${BASE}/entries/experience`, "POST", {
        company: "Northwind",
        title: "Engineer",
        order: 5,
        skillsUsed: ["Go", "Docker"],
        bullets: [{ text: "Built the pipeline" }, { text: "Cut costs 20%" }],
      }) as never,
      { params: Promise.resolve({ section: "experience" }) },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const dto = await getProfileDto();
    const entry = dto.profile.experience.find((e) => e.id === created.id)!;
    return { entry };
  }

  it("a field-only PATCH leaves bullets, order, sibling fields, and bullet ids untouched", async () => {
    const { entry } = await createExperienceWithBullets();
    const bulletIds = (entry as unknown as { bullets: BulletDto[] }).bullets.map((b) => b.id);

    const { PATCH } = await import("@/app/api/profile/entries/[section]/[id]/route");
    const res = await PATCH(
      jsonReq(`${BASE}/entries/experience/${entry.id}`, "PATCH", { company: "Northwind Ltd" }) as never,
      { params: Promise.resolve({ section: "experience", id: entry.id }) },
    );
    expect(res.status).toBe(200);

    const dto = await getProfileDto();
    const after = dto.profile.experience.find((e) => e.id === entry.id)! as unknown as {
      company: string;
      title: string;
      skillsUsed: string[];
      order: number;
      bullets: BulletDto[];
    };
    expect(after.company).toBe("Northwind Ltd");
    expect(after.title).toBe("Engineer");
    expect(after.order).toBe(5);
    expect(after.skillsUsed).toEqual(["Go", "Docker"]);
    expect(after.bullets.map((b) => b.id)).toEqual(bulletIds);
    expect(after.bullets.map((b) => b.text)).toEqual(["Built the pipeline", "Cut costs 20%"]);
  });

  it("a field-only PATCH on a user_confirmed entry succeeds and keeps its provenance", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const create = await POST(
      jsonReq(`${BASE}/entries/experience`, "POST", { company: "Acme", title: "Eng" }) as never,
      { params: Promise.resolve({ section: "experience" }) },
    );
    const { id } = (await create.json()) as { id: string };
    const { PATCH } = await import("@/app/api/profile/entries/[section]/[id]/route");
    await PATCH(
      jsonReq(`${BASE}/entries/experience/${id}`, "PATCH", { provenance: "user_confirmed" }) as never,
      { params: Promise.resolve({ section: "experience", id }) },
    );

    const res = await PATCH(
      jsonReq(`${BASE}/entries/experience/${id}`, "PATCH", { title: "Senior Eng" }) as never,
      { params: Promise.resolve({ section: "experience", id }) },
    );
    expect(res.status).toBe(200);
    const after = (await getProfileDto()).profile.experience.find((e) => e.id === id)!;
    expect(after.title).toBe("Senior Eng");
    expect(after.provenance).toBe("user_confirmed");
  });

  it("a field-only PATCH on an imported entry preserves provenance and review metadata", async () => {
    const doc = await db.sourceDocument.create({
      data: {
        userId: user.id,
        originalFilename: "t2.pdf",
        storagePath: "/tmp/t2.pdf",
        sha256: `h-${Math.random().toString(36).slice(2)}`,
        mimeType: "application/pdf",
        sizeBytes: 1,
        detectedLanguage: "en",
        extractedPages: [],
      },
    });
    const { importFromDraft } = await import("@/lib/profile/repository");
    await importFromDraft(
      user.id,
      doc.id,
      "en",
      {
        experience: [],
        education: [],
        skills: [
          {
            name: "Go",
            provenance: "imported",
            sourceDocumentId: doc.id,
            sourceLocator: { page: 2 },
            reviewFlag: "low_confidence",
            confidence: 0.4,
          },
        ],
        languages: [],
        projects: [],
        certifications: [],
      },
      "replace_parsed",
    );
    const imported = (await getProfileDto()).profile.skills.find((s) => s.name === "Go")!;

    const { PATCH } = await import("@/app/api/profile/entries/[section]/[id]/route");
    const res = await PATCH(
      jsonReq(`${BASE}/entries/skills/${imported.id}`, "PATCH", { name: "Golang" }) as never,
      { params: Promise.resolve({ section: "skills", id: imported.id }) },
    );
    expect(res.status).toBe(200);

    const after = (await getProfileDto()).profile.skills.find((s) => s.id === imported.id)! as unknown as {
      name: string;
      provenance: string;
      reviewFlag: string | null;
      confidence: number | null;
      sourceDocumentId: string | null;
      sourceLocator: { page?: number } | null;
    };
    expect(after.name).toBe("Golang");
    expect(after.provenance).toBe("imported");
    expect(after.reviewFlag).toBe("low_confidence");
    expect(after.confidence).toBe(0.4);
    expect(after.sourceDocumentId).toBe(doc.id);
    expect(after.sourceLocator).toMatchObject({ page: 2 });
  });

  it("renaming a skill onto an existing name is refused with 409; a unique rename succeeds", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const { PATCH } = await import("@/app/api/profile/entries/[section]/[id]/route");
    await POST(jsonReq(`${BASE}/entries/skills`, "POST", { name: "Kubernetes" }) as never, {
      params: Promise.resolve({ section: "skills" }),
    });
    const renameTarget = await POST(jsonReq(`${BASE}/entries/skills`, "POST", { name: "Terraform" }) as never, {
      params: Promise.resolve({ section: "skills" }),
    });
    const { id } = (await renameTarget.json()) as { id: string };

    const dup = await PATCH(
      jsonReq(`${BASE}/entries/skills/${id}`, "PATCH", { name: "kubernètes" }) as never,
      { params: Promise.resolve({ section: "skills", id }) },
    );
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { error: { code: string; details: { existingName: string } } };
    expect(body.error.code).toBe("DUPLICATE_SKILL");
    expect(body.error.details.existingName).toBe("Kubernetes");

    // Renaming an entry to its own (normalized) name is not a duplicate.
    const self = await PATCH(
      jsonReq(`${BASE}/entries/skills/${id}`, "PATCH", { name: "TERRAFORM" }) as never,
      { params: Promise.resolve({ section: "skills", id }) },
    );
    expect(self.status).toBe(200);

    const unique = await PATCH(
      jsonReq(`${BASE}/entries/skills/${id}`, "PATCH", { name: "OpenTofu" }) as never,
      { params: Promise.resolve({ section: "skills", id }) },
    );
    expect(unique.status).toBe(200);
    expect((await getProfileDto()).profile.skills.find((s) => s.id === id)?.name).toBe("OpenTofu");
  });

  it("null clears an optional date; empty string is rejected with 400", async () => {
    const { entry } = await createExperienceWithBullets();
    const { PATCH } = await import("@/app/api/profile/entries/[section]/[id]/route");

    const cleared = await PATCH(
      jsonReq(`${BASE}/entries/experience/${entry.id}`, "PATCH", { endDate: null }) as never,
      { params: Promise.resolve({ section: "experience", id: entry.id }) },
    );
    expect(cleared.status).toBe(200);

    const invalid = await PATCH(
      jsonReq(`${BASE}/entries/experience/${entry.id}`, "PATCH", { startDate: "" }) as never,
      { params: Promise.resolve({ section: "experience", id: entry.id }) },
    );
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("a bullets PATCH diffs by id: update in place, create new, delete removed", async () => {
    const { entry } = await createExperienceWithBullets();
    const before = (entry as unknown as { bullets: BulletDto[] }).bullets;
    const keptId = before[0].id;
    const removedId = before[1].id;

    const { PATCH } = await import("@/app/api/profile/entries/[section]/[id]/route");
    const res = await PATCH(
      jsonReq(`${BASE}/entries/experience/${entry.id}`, "PATCH", {
        bullets: [{ id: keptId, text: "Built the pipeline, faster" }, { text: "Hired two engineers" }],
      }) as never,
      { params: Promise.resolve({ section: "experience", id: entry.id }) },
    );
    expect(res.status).toBe(200);

    const after = (await getProfileDto()).profile.experience.find(
      (e) => e.id === entry.id,
    )! as unknown as { bullets: BulletDto[] };
    expect(after.bullets).toHaveLength(2);
    expect(after.bullets.find((b) => b.id === keptId)?.text).toBe("Built the pipeline, faster");
    expect(after.bullets.find((b) => b.id === removedId)).toBeUndefined();
    expect(after.bullets.find((b) => !before.some((b0) => b0.id === b.id))?.text).toBe("Hired two engineers");
  });

  it("deleting an entry removes its bullets (no orphans) and leaves siblings untouched", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const { DELETE } = await import("@/app/api/profile/entries/[section]/[id]/route");
    const createExperience = async (company: string, bullets?: Array<{ text: string }>) => {
      const res = await POST(
        jsonReq(`${BASE}/entries/experience`, "POST", { company, title: "Eng", bullets }) as never,
        { params: Promise.resolve({ section: "experience" }) },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };

    const withBullets = await createExperience("Delete Me Co", [{ text: "Orphan check" }, { text: "Second" }]);
    const sibling = await createExperience("Sibling Co");

    const versionBefore = (await getProfileDto()).profile.version;
    const del = await DELETE(null as never, {
      params: Promise.resolve({ section: "experience", id: withBullets }),
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { version: number }).version).toBe(versionBefore + 1);

    const orphaned = await db.bullet.findMany({ where: { experienceId: withBullets } });
    expect(orphaned).toHaveLength(0);
    const dto = await getProfileDto();
    expect(dto.profile.experience.map((e) => e.id)).toEqual([sibling]);
  });

  it("DELETE works in every section and bumps the version", async () => {
    const { POST } = await import("@/app/api/profile/entries/[section]/route");
    const { DELETE } = await import("@/app/api/profile/entries/[section]/[id]/route");
    const payloads: Record<string, Record<string, unknown>> = {
      experience: { company: "Del Co", title: "X" },
      education: { institution: "Del U" },
      skills: { name: "DelSkill" },
      languages: { name: "DelLang" },
      projects: { name: "DelProject" },
      certifications: { title: "DelCert" },
    };
    for (const [section, payload] of Object.entries(payloads)) {
      const res = await POST(jsonReq(`${BASE}/entries/${section}`, "POST", payload) as never, {
        params: Promise.resolve({ section }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const versionBefore = (await getProfileDto()).profile.version;
      const del = await DELETE(null as never, { params: Promise.resolve({ section, id }) });
      expect(del.status).toBe(200);
      expect(((await del.json()) as { version: number }).version).toBe(versionBefore + 1);
    }
  });
});
