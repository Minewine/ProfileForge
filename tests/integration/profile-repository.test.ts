import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import {
  createEntry,
  deleteEntry,
  getOrCreateProfile,
  getProfile,
  importFromDraft,
  listVersions,
  restoreVersion,
  updateBasics,
  updateEntry,
  type SectionPayloads,
} from "@/lib/profile/repository";
import { resetAuth, signIn, type SessionUser } from "../support/auth";

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

async function seedSourceDoc() {
  return db.sourceDocument.create({
    data: {
      userId: user.id,
      originalFilename: "test.pdf",
      storagePath: "/tmp/test.pdf",
      sha256: `hash-${Math.random().toString(36).slice(2)}`,
      mimeType: "application/pdf",
      sizeBytes: 1000,
      detectedLanguage: "en",
      extractedPages: [],
    },
  });
}

let user: SessionUser;

beforeEach(async () => {
  await resetAuth();
  user = await signIn("profile-repo@example.com");
  await cleanDb();
});

describe("profile repository", () => {
  it("bumps version and appends a snapshot on every mutation", async () => {
    const before = await getProfile(user.id);
    const result = await createEntry(user.id, "skills", { name: "Kubernetes", category: "DevOps" });
    expect(result.version).toBe(before.version + 1);

    const versions = await listVersions(user.id);
    expect(versions.versions[0].cause).toBe("edit");
    expect(versions.versions[0].version).toBe(result.version);
  });

  it("rejects duplicate skills case/accent-insensitively with existingId", async () => {
    await createEntry(user.id, "skills", { name: "Kubernetes" });
    await expect(createEntry(user.id, "skills", { name: "kubernetes" })).rejects.toMatchObject({
      code: "DUPLICATE_SKILL",
    });
    await expect(createEntry(user.id, "skills", { name: "Kubernètes" })).rejects.toBeInstanceOf(ApiError);
    try {
      await createEntry(user.id, "skills", { name: "KUBERNETES" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ApiError).code).toBe("DUPLICATE_SKILL");
      expect((err as ApiError).details).toHaveProperty("existingId");
    }
  });

  it("warns (does not block) on overlapping experience dates", async () => {
    const a = await createEntry(user.id, "experience", {
      company: "Acme",
      title: "Dev",
      startDate: "2020-01",
      endDate: "2022-06",
    });
    const entry = (await getProfile(user.id)).experience.find((e) => e.company === "Acme")!;
    const b = await createEntry(user.id, "experience", {
      company: "Beta",
      title: "Senior Dev",
      startDate: "2021-01",
      endDate: "2023-01",
    });
    expect(b.warnings.map((w) => w.code)).toContain("DATE_RANGE_OVERLAP");

    // Editing to remove the overlap clears the warning
    const fixed = await updateEntry(user.id, "experience", entry.id, { endDate: "2020-12" });
    expect(fixed.warnings.map((w) => w.code)).not.toContain("DATE_RANGE_OVERLAP");
    void a;
  });

  it("allows user_confirmed only for flagged imported entries and clears the flag", async () => {
    const doc = await seedSourceDoc();
    await importFromDraft(user.id, doc.id, "en", {
      experience: [
        {
          company: "Acme",
          title: "Dev",
          startDate: "2020-01",
          provenance: "imported",
          sourceDocumentId: doc.id,
          sourceLocator: { page: 1 },
          language: "en",
          reviewFlag: "low_confidence",
          bullets: [
            {
              text: "Built things",
              provenance: "imported",
              sourceDocumentId: doc.id,
              sourceLocator: { page: 1 },
              reviewFlag: "containment_failed",
            },
          ],
        },
      ],
      education: [],
      skills: [{ name: "Go", provenance: "imported", sourceDocumentId: doc.id, sourceLocator: { page: 2 } }],
      languages: [],
      projects: [],
      certifications: [],
    } satisfies SectionPayloads, "replace_parsed");

    const profile = await getProfile(user.id);
    const exp = profile.experience[0];
    expect(exp.provenance).toBe("imported");
    expect(exp.reviewFlag).toBe("low_confidence");

    const confirmed = await updateEntry(user.id, "experience", exp.id, { provenance: "user_confirmed" });
    const after = (await getProfile(user.id)).experience[0];
    expect(after.provenance).toBe("user_confirmed");
    expect(after.reviewFlag).toBeNull();
    expect(confirmed.version).toBeGreaterThan(profile.version);

    // A clean imported entry cannot be user_confirmed
    const skill = (await getProfile(user.id)).skills[0];
    await expect(updateEntry(user.id, "skills", skill.id, { provenance: "user_confirmed" })).rejects.toMatchObject(
      { code: "VALIDATION_ERROR" },
    );
  });

  it("replace_parsed preserves user-entered entries; merge skips duplicate skills", async () => {
    await createEntry(user.id, "skills", { name: "Kubernetes", provenance: "user_entered" });
    const doc = await seedSourceDoc();

    const first = await importFromDraft(
      user.id,
      doc.id,
      "en",
      {
        experience: [],
        education: [],
        skills: [{ name: "Go", provenance: "imported", sourceDocumentId: doc.id, sourceLocator: { page: 1 } }],
        languages: [],
        projects: [],
        certifications: [],
      } satisfies SectionPayloads,
      "replace_parsed",
    );
    expect(first.preservedUserEntries).toBe(1);

    const second = await importFromDraft(
      user.id,
      doc.id,
      "en",
      {
        experience: [],
        education: [],
        skills: [{ name: "kubernetes", provenance: "imported", sourceDocumentId: doc.id, sourceLocator: { page: 1 } }],
        languages: [],
        projects: [],
        certifications: [],
      } satisfies SectionPayloads,
      "merge",
    );
    expect(second.skippedDuplicateSkills).toEqual(["kubernetes"]);
    expect((await getProfile(user.id)).skills.filter((s) => s.provenance === "imported").length).toBe(1);
  });

  it("restores a previous version", async () => {
    await createEntry(user.id, "skills", { name: "Go" });
    const v1 = (await getProfile(user.id)).version;
    const skill = (await getProfile(user.id)).skills[0];
    await deleteEntry(user.id, "skills", skill.id);
    expect((await getProfile(user.id)).skills).toHaveLength(0);

    await restoreVersion(user.id, v1);
    expect((await getProfile(user.id)).skills.map((s) => s.name)).toEqual(["Go"]);
    const versions = await listVersions(user.id);
    expect(versions.versions[0].cause).toBe("restore");
  });
});

describe("one profile per user — CV imports must land on the profile the editor reads", () => {
  it("concurrent getOrCreateProfile calls resolve to a single shared profile", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateProfile(user.id)));
    expect(new Set(results.map((p) => p.id)).size).toBe(1);
    expect(await db.profile.findMany({ where: { userId: user.id } })).toHaveLength(1);
  });

  it("rejects a second profile row for the same user at the DB level", async () => {
    await getOrCreateProfile(user.id);
    await expect(db.profile.create({ data: { userId: user.id, language: "en" } })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("basics and imported section entries end up on the same profile", async () => {
    // Mirrors POST /api/profile/import: basics are carried over first, then
    // section payloads are imported. A duplicate-profile race used to split
    // these across two rows, so the editor saw basics only.
    const doc = await seedSourceDoc();
    await updateBasics(user.id, {
      basics: { name: "Michael Coughlan", email: "coughlan@gmail.com", phone: "+41 78 900 0022", location: "Geneva, Switzerland" },
    });
    const payloads = {
      experience: [
        {
          company: "Rametric",
          title: "Founder & Lead Developer",
          startDate: "2020-08",
          endDate: "present",
          provenance: "imported",
          sourceDocumentId: doc.id,
          sourceLocator: { page: 1 },
          language: "en",
          reviewFlag: null,
          bullets: [
            {
              text: "Leading the development of Docsumm, an AI-powered document summarization tool.",
              provenance: "imported",
              sourceDocumentId: doc.id,
              sourceLocator: { page: 1 },
              language: "en",
              containmentOk: true,
              reviewFlag: null,
            },
          ],
        },
      ],
      education: [
        {
          institution: "CSC",
          provenance: "imported",
          sourceDocumentId: doc.id,
          sourceLocator: { page: 2 },
          language: "en",
        },
      ],
      skills: [{ name: "AI strategy", provenance: "imported", sourceDocumentId: doc.id, sourceLocator: { page: 2 } }],
      languages: [],
      projects: [],
      certifications: [],
    } satisfies SectionPayloads;
    for (const mode of ["replace_parsed", "merge"] as const) {
      // start each mode from a clean slate (keep the profile + basics row)
      await db.profileSnapshot.deleteMany({});
      await db.bullet.deleteMany({});
      await db.experience.deleteMany({});
      await db.education.deleteMany({});
      await db.skill.deleteMany({});
      await db.languageSkill.deleteMany({});
      await db.project.deleteMany({});
      await db.certification.deleteMany({});

      await importFromDraft(user.id, doc.id, "en", payloads, mode);
      const view = await getProfile(user.id);
      expect(view.basics?.name).toBe("Michael Coughlan");
      expect(view.experience).toHaveLength(1);
      expect(view.experience[0]!.company).toBe("Rametric");
      expect(view.experience[0]!.bullets).toHaveLength(1);
      expect(view.education).toHaveLength(1);
      expect(view.skills.map((s) => s.name)).toContain("AI strategy");
      expect(await db.profile.findMany({ where: { userId: user.id } })).toHaveLength(1);
    }
  });
});

describe("spec 007 — snapshots stay PinnedSnapshot-valid through edits (US5)", () => {
  it("the newest snapshot after edits validates and resolves the edited content for template export", async () => {
    const { PinnedSnapshotSchema } = await import("@/lib/generation/plan");
    const { renderMetaOf } = await import("@/lib/generation/render/cv");

    const created = await createEntry(user.id, "experience", {
      company: "Snapshot Co",
      title: "Engineer",
      bullets: [{ text: "One" }, { text: "Two" }],
    });
    const entry = (await getProfile(user.id)).experience.find((e) => e.id === created.id)!;
    const keptId = entry.bullets[0]!.id;

    await updateEntry(user.id, "experience", created.id, { company: "Snapshot Co Ltd" });
    await updateEntry(user.id, "experience", created.id, {
      bullets: [{ id: keptId, text: "One reworded" }, { text: "Three" }],
    });

    const snapshot = await db.profileSnapshot.findFirst({ orderBy: { version: "desc" } });
    expect(snapshot).toBeTruthy();
    const parsed = PinnedSnapshotSchema.safeParse(snapshot!.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return; // narrowed above; keeps TS happy

    const pinned = parsed.data.experience.find((e) => e.company === "Snapshot Co Ltd")!;
    expect(pinned.id).toBe(created.id);
    expect(pinned.bullets.map((b) => b.id)).toContain(keptId);
    expect(pinned.bullets.map((b) => b.text)).toEqual(["One reworded", "Three"]);

    // Template export resolves entry content from the snapshot by id (render/cv.ts).
    const meta = renderMetaOf.experience(parsed.data, created.id);
    expect(meta?.company).toBe("Snapshot Co Ltd");
    expect(meta?.title).toBe("Engineer");
  });
});
