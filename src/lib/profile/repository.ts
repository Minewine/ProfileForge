import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { normalizeName } from "@/lib/files/storage";
import type {
  Basics,
  LanguageCode,
  SectionName,
  SourceLocator,
  Warning,
} from "@/lib/validation/schemas";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

/** Section delegates have heterogeneous shapes; route them through one shim. */
function delegate(client: Client, section: SectionName) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any)[SECTION_DELEGATE[section]] as {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    delete: (args: { where: { id: string } }) => Promise<unknown>;
    findUnique: (args: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<unknown>;
    findMany: (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => Promise<
      Array<Record<string, unknown>>
    >;
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
}

type EntryInput = Record<string, unknown> & {
  order?: number;
  bullets?: Array<Record<string, unknown>>;
};

export type SectionPayloads = {
  experience: Array<EntryInput & { company: string; title: string }>;
  education: Array<EntryInput & { institution: string }>;
  skills: Array<EntryInput & { name: string }>;
  languages: Array<EntryInput & { name: string }>;
  projects: Array<EntryInput & { name: string }>;
  certifications: Array<EntryInput & { title: string }>;
};

const SECTION_DELEGATE = {
  experience: "experience",
  education: "education",
  skills: "skill",
  languages: "languageSkill",
  projects: "project",
  certifications: "certification",
} as const;

// --- Profile ---

export async function getOrCreateProfile(userId: string, language: LanguageCode = "en") {
  const findExisting = () =>
    db.profile.findFirst({ where: { userId }, orderBy: { createdAt: "asc" }, include: includeAll });
  const existing = await findExisting();
  if (existing) return existing;
  try {
    return await db.profile.create({ data: { language, userId }, include: includeAll });
  } catch (err) {
    // Lost a create race against a concurrent caller. The unique index on
    // Profile.userId guarantees exactly one row — re-read it deterministically.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existingAfterRace = await findExisting();
      if (existingAfterRace) return existingAfterRace;
    }
    throw err;
  }
}

const includeAll = {
  experiences: { orderBy: { order: "asc" as const }, include: { bullets: { orderBy: { order: "asc" as const } } } },
  educations: { orderBy: { order: "asc" as const } },
  skills: { orderBy: { order: "asc" as const } },
  languages: { orderBy: { order: "asc" as const } },
  projects: { orderBy: { order: "asc" as const }, include: { bullets: { orderBy: { order: "asc" as const } } } },
  certifications: { orderBy: { order: "asc" as const } },
};

async function getProfileRaw(client: Client, id: string) {
  return client.profile.findUniqueOrThrow({ where: { id }, include: includeAll });
}

type ProfileWithRelations = Awaited<ReturnType<typeof getProfileRaw>>;

export type ProfileDto = Awaited<ReturnType<typeof getProfile>>;

export async function getProfile(userId: string) {
  const profile = await getOrCreateProfile(userId);
  const parsed = await getProfileRaw(db, profile.id);
  return serializeProfile(parsed);
}

function serializeProfile(p: ProfileWithRelations) {
  const flagged = countFlags(p);
  return {
    id: p.id,
    version: p.version,
    language: p.language as LanguageCode,
    basics: (p.basics ?? null) as Basics | null,
    experience: p.experiences,
    education: p.educations,
    skills: p.skills,
    languages: p.languages,
    projects: p.projects,
    certifications: p.certifications,
    lowConfidenceCount: flagged,
    updatedAt: p.updatedAt.toISOString(),
  };
}

function countFlags(p: ProfileWithRelations): number {
  let n = 0;
  const entry = (e: { reviewFlag: string | null }) => e.reviewFlag != null && n++;
  p.experiences.forEach((e) => {
    entry(e);
    e.bullets.forEach(entry);
  });
  p.educations.forEach(entry);
  p.skills.forEach(entry);
  p.languages.forEach(entry);
  p.projects.forEach((e) => {
    entry(e);
    e.bullets.forEach(entry);
  });
  p.certifications.forEach(entry);
  return n;
}

// --- Mutations: every change bumps version + appends a snapshot, atomically ---

type SnapshotCause = "import" | "edit" | "restore";

async function commitMutation(
  tx: Tx,
  profileId: string,
  cause: SnapshotCause,
): Promise<{ version: number }> {
  const profile = await tx.profile.update({
    where: { id: profileId },
    data: { version: { increment: 1 } },
  });
  const snapshotData = await serializeForSnapshot(tx, profileId);
  await tx.profileSnapshot.create({
    data: { profileId, version: profile.version, cause, data: snapshotData },
  });
  return { version: profile.version };
}

async function serializeForSnapshot(tx: Tx, profileId: string) {
  const p = await getProfileRaw(tx, profileId);
  return serializeProfile(p) as unknown as object;
}

export async function updateBasics(userId: string, patch: { basics?: Basics; language?: LanguageCode }) {
  const profile = await getOrCreateProfile(userId);
  return db.$transaction(async (tx) => {
    await tx.profile.update({
      where: { id: profile.id },
      data: {
        ...(patch.basics ? { basics: patch.basics } : {}),
        ...(patch.language ? { language: patch.language } : {}),
      },
    });
    return commitMutation(tx, profile.id, "edit");
  });
}

// --- Entries ---

export async function createEntry(userId: string, section: SectionName, input: EntryInput) {
  const profile = await getOrCreateProfile(userId);
  if (section === "skills") await assertSkillNameFree(profile.id, String(input.name));

  return db.$transaction(async (tx) => {
    const created = await insertEntry(tx, profile.id, section, input, "user_entered");
    const warnings: Warning[] = [];
    if (section === "experience") {
      const overlap = await detectDateOverlap(tx, profile.id, created.id);
      if (overlap) warnings.push(overlap);
    }
    const result = await commitMutation(tx, profile.id, "edit");
    return { id: created.id, ...result, warnings };
  });
}

export async function updateEntry(userId: string, section: SectionName, id: string, patch: EntryInput & { provenance?: string }) {
  const profile = await getOrCreateProfile(userId);
  const warnings: Warning[] = [];

  if (section === "skills" && typeof patch.name === "string") {
    await assertSkillNameFree(profile.id, patch.name, id);
  }

  return db.$transaction(async (tx) => {
    const existing = await findEntry(tx, section, id, profile.id);

    if (patch.provenance && patch.provenance !== existing.provenance) {
      applyProvenanceTransition(
        existing as unknown as { provenance: string; reviewFlag: string | null; confidence: number | null },
        patch.provenance,
      );
    }

    const data = buildEntryUpdate(section, existing, patch);

    await delegate(tx, section).update({ where: { id }, data });

    // Diff the bullet children when the payload carries a bullets array.
    if (Array.isArray(patch.bullets) && (section === "experience" || section === "projects")) {
      await syncBullets(tx, section, id, patch.bullets as Array<EntryInput>);
    }

    if (section === "experience") {
      const overlap = await detectDateOverlap(tx, profile.id, id);
      if (overlap) warnings.push(overlap);
    }

    const result = await commitMutation(tx, profile.id, "edit");
    return { ...result, warnings };
  });
}

export async function deleteEntry(userId: string, section: SectionName, id: string) {
  const profile = await getOrCreateProfile(userId);
  return db.$transaction(async (tx) => {
    await delegate(tx, section).delete({ where: { id } });
    return commitMutation(tx, profile.id, "edit");
  });
}

function applyProvenanceTransition(
  existing: { provenance: string; reviewFlag: string | null; confidence: number | null },
  next: string,
) {
  if (next === "user_confirmed") {
    if (existing.provenance === "imported" && existing.reviewFlag == null) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Only entries with an open review flag (low confidence or failed containment) can be user-confirmed.",
      );
    }
    return; // reviewFlag cleared in buildEntryUpdate
  }
  if (existing.provenance === "imported" && next === "user_entered") {
    return; // re-attributing to user is allowed (drops imported semantics below)
  }
  throw new ApiError("VALIDATION_ERROR", `Unsupported provenance transition.`);
}

function buildEntryUpdate(section: SectionName, existing: Record<string, unknown>, patch: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  const copyKeys = Object.keys(patch).filter(
    (k) => k !== "id" && k !== "bullets" && k !== "provenance" && patch[k] !== undefined,
  );
  for (const k of copyKeys) data[k] = patch[k];

  if (patch.provenance !== undefined) {
    data.provenance = patch.provenance;
    if (patch.provenance === "user_confirmed") {
      data.reviewFlag = null; // confirmation clears the flag (contracts/api.md)
    }
    if (patch.provenance === "user_entered") {
      data.reviewFlag = null;
      data.confidence = null;
      data.sourceDocumentId = null;
      data.sourceLocator = null;
    }
  }
  return data;
}

/**
 * Apply a bullet-set diff for an experience/project entry. Bullet ids must stay
 * stable across edits — PinnedSnapshotSchema requires them and the provenance
 * drill-down keeps per-bullet evidence. Payload items with a known id are updated in place
 * (provenance fields only when provided; source fields never touched), id-less
 * items are created (user_entered — newly typed text is the user's, not the
 * document's), and stored ids absent from the payload are deleted.
 */
async function syncBullets(tx: Tx, owner: "experience" | "projects", ownerId: string, bullets: Array<EntryInput>) {
  const ownerKey = owner === "experience" ? { experienceId: ownerId } : { projectId: ownerId };
  const existingIds = new Set(
    (await tx.bullet.findMany({ where: ownerKey, select: { id: true } })).map((row) => row.id),
  );
  const keepIds = new Set<string>();

  for (const [i, b] of bullets.entries()) {
    const order = typeof b.order === "number" ? b.order : i;
    const meta = {
      provenance: b.provenance as string | undefined,
      containmentOk: b.containmentOk as boolean | null | undefined,
      confidence: b.confidence as number | null | undefined,
      reviewFlag: b.reviewFlag as string | null | undefined,
      language: b.language as string | null | undefined,
    };
    if (typeof b.id === "string" && existingIds.has(b.id)) {
      keepIds.add(b.id);
      // Prisma skips undefined fields, so provided-only meta stays provided-only.
      await tx.bullet.update({ where: { id: b.id }, data: { text: String(b.text), order, ...meta } });
    } else {
      await tx.bullet.create({
        data: {
          ...ownerKey,
          text: String(b.text),
          order,
          provenance: meta.provenance ?? "user_entered",
          containmentOk: meta.containmentOk,
          confidence: meta.confidence,
          reviewFlag: meta.reviewFlag,
          language: meta.language,
        },
      });
    }
  }

  const orphans = [...existingIds].filter((id) => !keepIds.has(id));
  if (orphans.length > 0) {
    await tx.bullet.deleteMany({ where: { id: { in: orphans } } });
  }
}

async function insertEntry(tx: Tx, profileId: string, section: SectionName, input: EntryInput, provenance: string) {
  const { bullets, ...fields } = input;
  delete fields.id;
  const data: Record<string, unknown> = { ...fields, profileId, provenance };
  if (provenance === "user_entered") {
    data.confidence = null;
    data.reviewFlag = null;
    data.sourceDocumentId = null;
    data.sourceLocator = null;
  }
  const created = await delegate(tx, section).create({ data });
  if (Array.isArray(bullets) && (section === "experience" || section === "projects")) {
    for (const [i, b] of (bullets as Array<EntryInput>).entries()) {
      await tx.bullet.create({
        data: {
          ...(section === "experience" ? { experienceId: created.id } : { projectId: created.id }),
          text: String(b.text),
          order: typeof b.order === "number" ? b.order : i,
          provenance: (b.provenance as string) ?? provenance,
          confidence: (b.confidence as number | null) ?? null,
          containmentOk: (b.containmentOk as boolean | null) ?? null,
          reviewFlag: (b.reviewFlag as string | null) ?? null,
          language: (b.language as string | null) ?? null,
        },
      });
    }
  }
  return created;
}

async function findEntry(tx: Tx, section: SectionName, id: string, profileId: string) {
  const found = await delegate(tx, section).findUnique({ where: { id } });
  if (!found || ("profileId" in found && found.profileId !== profileId)) {
    throw new ApiError("NOT_FOUND", `${section} entry not found.`);
  }
  return found;
}

async function assertSkillNameFree(profileId: string, name: string, excludeId?: string) {
  const skills = await db.skill.findMany({ where: { profileId }, select: { id: true, name: true } });
  const normalized = normalizeName(name);
  const dup = skills.find((s) => s.id !== excludeId && normalizeName(s.name) === normalized);
  if (dup) {
    throw new ApiError("DUPLICATE_SKILL", `A skill with a similar name already exists.`, {
      existingId: dup.id,
      existingName: dup.name,
    });
  }
}

async function detectDateOverlap(tx: Tx, profileId: string, excludeId: string): Promise<Warning | null> {
  const experiences = await tx.experience.findMany({ where: { profileId } });
  const withRanges = experiences.filter((e) => e.startDate).map((e) => ({
    id: e.id,
    start: e.startDate!,
    end: e.endDate === "present" || !e.endDate ? "9999-12" : e.endDate,
  }));
  const target = withRanges.find((e) => e.id === excludeId);
  if (!target) return null;
  const clash = withRanges.find(
    (e) => e.id !== excludeId && e.start <= target.end && target.start <= e.end,
  );
  if (!clash) return null;
  return {
    code: "DATE_RANGE_OVERLAP",
    message:
      "This role's dates overlap another role's — open the Profile editor and adjust the Start/End dates so each role has its own period.",
  };
}

// --- Import (contracts/api.md POST /api/profile/import) ---

export async function importFromDraft(
  userId: string,
  sourceDocumentId: string,
  language: LanguageCode,
  payloads: SectionPayloads,
  mode: "replace_parsed" | "merge",
) {
  const profile = await getOrCreateProfile(userId, language);
  const doc = await db.sourceDocument.findFirst({ where: { id: sourceDocumentId, userId } });
  if (!doc) throw new ApiError("NOT_FOUND", "Source document not found.");

  const skippedDuplicateSkills: string[] = [];

  const result = await db.$transaction(async (tx) => {
    if (mode === "replace_parsed") {
      // bullets cascade with their parent entries (scoped to THIS profile —
      // a global delete would wipe other users' imported entries)
      await tx.experience.deleteMany({ where: { profileId: profile.id, provenance: "imported" } });
      await tx.education.deleteMany({ where: { profileId: profile.id, provenance: "imported" } });
      await tx.project.deleteMany({ where: { profileId: profile.id, provenance: "imported" } });
      await tx.certification.deleteMany({ where: { profileId: profile.id, provenance: "imported" } });
      await tx.languageSkill.deleteMany({ where: { profileId: profile.id, provenance: "imported" } });
      await tx.skill.deleteMany({ where: { profileId: profile.id, provenance: "imported" } });
    }

    if (mode === "merge") {
      const existingSkills = await tx.skill.findMany({ where: { profileId: profile.id } });
      const existingNames = new Set(existingSkills.map((s) => normalizeName(s.name)));
      payloads.skills = payloads.skills.filter((s) => {
        if (existingNames.has(normalizeName(s.name))) {
          skippedDuplicateSkills.push(s.name);
          return false;
        }
        existingNames.add(normalizeName(s.name));
        return true;
      });
    }

    let importedCount = 0;
    for (const section of Object.keys(SECTION_DELEGATE) as SectionName[]) {
      for (const entry of payloads[section]) {
        await insertEntry(tx, profile.id, section, entry, "imported");
        importedCount++;
      }
    }

    await tx.sourceDocument.update({ where: { id: sourceDocumentId }, data: { importedAt: new Date() } });
    const mutation = await commitMutation(tx, profile.id, "import");
    const preserved = await countUserEntries(tx, profile.id);
    return { ...mutation, imported: importedCount, preservedUserEntries: preserved };
  });

  return { ...result, skippedDuplicateSkills };
}

async function countUserEntries(tx: Tx, profileId: string) {
  const [e, ed, s, l, p, c] = await Promise.all([
    tx.experience.count({ where: { profileId, provenance: { in: ["user_entered", "user_confirmed"] } } }),
    tx.education.count({ where: { profileId, provenance: { in: ["user_entered", "user_confirmed"] } } }),
    tx.skill.count({ where: { profileId, provenance: { in: ["user_entered", "user_confirmed"] } } }),
    tx.languageSkill.count({ where: { profileId, provenance: { in: ["user_entered", "user_confirmed"] } } }),
    tx.project.count({ where: { profileId, provenance: { in: ["user_entered", "user_confirmed"] } } }),
    tx.certification.count({ where: { profileId, provenance: { in: ["user_entered", "user_confirmed"] } } }),
  ]);
  return e + ed + s + l + p + c;
}

// --- Versions ---

export async function listVersions(userId: string) {
  const profile = await getOrCreateProfile(userId);
  const snapshots = await db.profileSnapshot.findMany({
    where: { profileId: profile.id },
    orderBy: { version: "desc" },
    select: { version: true, cause: true, createdAt: true },
  });
  return {
    currentVersion: profile.version,
    versions: snapshots.map((s) => ({
      version: s.version,
      cause: s.cause,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

export async function restoreVersion(userId: string, version: number) {
  const profile = await getOrCreateProfile(userId);
  const snapshot = await db.profileSnapshot.findUnique({
    where: { profileId_version: { profileId: profile.id, version } },
  });
  if (!snapshot) throw new ApiError("NOT_FOUND", `No snapshot for version ${version}.`);

  return db.$transaction(async (tx) => {
    const data = snapshot.data as { experience: unknown[]; education: unknown[]; skills: unknown[]; languages: unknown[]; projects: unknown[]; certifications: unknown[] };
    await tx.experience.deleteMany({ where: { profileId: profile.id } });
    await tx.education.deleteMany({ where: { profileId: profile.id } });
    await tx.skill.deleteMany({ where: { profileId: profile.id } });
    await tx.languageSkill.deleteMany({ where: { profileId: profile.id } });
    await tx.project.deleteMany({ where: { profileId: profile.id } });
    await tx.certification.deleteMany({ where: { profileId: profile.id } });

    for (const section of ["experience", "education", "skills", "languages", "projects", "certifications"] as const) {
      for (const entry of (data[section] ?? []) as Array<EntryInput>) {
        await insertEntry(tx, profile.id, section, entry, (entry.provenance as string) ?? "user_entered");
      }
    }
    await tx.profile.update({
      where: { id: profile.id },
      data: { basics: (snapshot.data as { basics?: unknown }).basics ?? Prisma.DbNull },
    });
    return commitMutation(tx, profile.id, "restore");
  });
}

// --- Misc helpers used by routes ---

export async function entriesReferencingDocument(sourceDocumentId: string) {
  const [e, ed, s, l, p, c, b] = await Promise.all([
    db.experience.findMany({ where: { sourceDocumentId }, select: { id: true } }),
    db.education.findMany({ where: { sourceDocumentId }, select: { id: true } }),
    db.skill.findMany({ where: { sourceDocumentId }, select: { id: true } }),
    db.languageSkill.findMany({ where: { sourceDocumentId }, select: { id: true } }),
    db.project.findMany({ where: { sourceDocumentId }, select: { id: true } }),
    db.certification.findMany({ where: { sourceDocumentId }, select: { id: true } }),
    db.bullet.findMany({ where: { sourceDocumentId }, select: { id: true } }),
  ]);
  return [...e, ...ed, ...s, ...l, ...p, ...c, ...b].map((r) => r.id);
}

export function locatorFromPage(page: number | null | undefined, section?: string): SourceLocator {
  const locator: SourceLocator = {};
  if (page != null) locator.page = page;
  if (section) locator.section = section;
  return locator;
}
