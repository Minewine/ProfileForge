import { beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { resetAuth, signIn } from "../support/auth";
import { assignOwner } from "../../scripts/assign-owner";

/**
 * Legacy-data claim contract (specs/008 US4 / FR-009, SC-005): the one-time
 * script attaches ALL quarantined (userId NULL) rows to one designated owner,
 * is idempotent, and quarantined rows stay invisible to other users before and
 * after the claim.
 */
let owner: { id: string; email: string };
let other: { id: string; email: string };

beforeEach(async () => {
  await db.llmUsageLog.deleteMany({});
  await db.appSettings.deleteMany({});
  await db.jobAnalysis.deleteMany({});
  await db.sourceDocument.deleteMany({});
  await db.profile.deleteMany({});
  await resetAuth();
  owner = await signIn("owner-claim@example.com");
  other = await signIn("other-claim@example.com"); // last signed in, but rows are asserted by id
});

async function seedQuarantined() {
  const profile = await db.profile.create({ data: { userId: null, language: "en" } });
  const doc = await db.sourceDocument.create({
    data: {
      userId: null,
      originalFilename: "legacy.pdf",
      storagePath: "uploads-test/legacy.pdf",
      sha256: createHash("sha256").update(randomBytes(8)).digest("hex"),
      mimeType: "application/pdf",
      sizeBytes: 10,
      detectedLanguage: "en",
      extractedPages: [],
    },
  });
  const analysis = await db.jobAnalysis.create({
    data: { userId: null, jdText: "legacy jd", language: "en" },
  });
  const usage = await db.llmUsageLog.create({
    data: { userId: null, task: "t", model: "m", runId: "legacy-run" },
  });
  const settings = await db.appSettings.create({
    data: { userId: null, keyHint: "legacy-hint" }, // the pre-feature "singleton" row
  });
  return { profile, doc, analysis, usage, settings };
}

describe("assignOwner (scripts/assign-owner.ts)", () => {
  it("claims every quarantined row for the designated owner in one pass", async () => {
    await seedQuarantined();

    const result = await assignOwner("owner-claim@example.com", "password-123");

    expect(result.user.id).toBe(owner.id);
    expect(result.counts).toMatchObject({ profiles: 1, sourceDocuments: 1, jobAnalyses: 1, llmUsageLogs: 1, appSettings: 1 });
    const claimed = await db.profile.findFirstOrThrow();
    expect(claimed.userId).toBe(owner.id);
    expect(await db.sourceDocument.count({ where: { userId: owner.id } })).toBe(1);
    expect(await db.jobAnalysis.count({ where: { userId: owner.id } })).toBe(1);
    expect(await db.llmUsageLog.count({ where: { userId: owner.id } })).toBe(1);
    expect(await db.appSettings.count({ where: { userId: owner.id } })).toBe(1);
  });

  it("creates the owner when absent, with a verifiable Argon2id password", async () => {
    const created = await assignOwner("fresh-owner@example.com", "fresh-password-1");
    const row = await db.user.findUniqueOrThrow({ where: { email: "fresh-owner@example.com" } });
    expect(row.id).toBe(created.user.id);
    expect(row.passwordHash.startsWith("$argon2")).toBe(true);
  });

  it("merges the legacy settings row instead of violating the unique constraint when the owner already has settings", async () => {
    await seedQuarantined();
    await db.appSettings.create({ data: { userId: owner.id, keyHint: "owner-own-hint" } });

    const result = await assignOwner("owner-claim@example.com", "password-123");

    expect(result.counts.appSettings).toBe(1); // 1 legacy row deleted, owner's own row kept
    expect(await db.appSettings.findUniqueOrThrow({ where: { userId: owner.id } }).then((r) => r.keyHint)).toBe("owner-own-hint");
    expect(await db.appSettings.count({ where: { userId: owner.id } })).toBe(1);
    expect(await db.appSettings.count({ where: { userId: null } })).toBe(0);
  });

  it("is idempotent — a second run claims nothing and changes nothing", async () => {
    await seedQuarantined();
    await assignOwner("owner-claim@example.com", "password-123");
    const snapshot = {
      profiles: await db.profile.count({ where: { userId: owner.id } }),
      docs: await db.sourceDocument.count({ where: { userId: owner.id } }),
      analyses: await db.jobAnalysis.count({ where: { userId: owner.id } }),
      usage: await db.llmUsageLog.count({ where: { userId: owner.id } }),
      settings: await db.appSettings.count(),
    };

    const second = await assignOwner("owner-claim@example.com", "password-123");

    expect(second.counts).toEqual({ profiles: 0, sourceDocuments: 0, jobAnalyses: 0, llmUsageLogs: 0, appSettings: 0 });
    expect(await db.profile.count({ where: { userId: owner.id } })).toBe(snapshot.profiles);
  });

  it("quarantined rows stay invisible to other users after the claim", async () => {
    await seedQuarantined();
    await assignOwner("owner-claim@example.com", "password-123");

    const analysis = await db.jobAnalysis.findFirstOrThrow({ where: { userId: owner.id } });
    // another user's scoped query (userId equality) can never match it:
    expect(await db.jobAnalysis.count({ where: { userId: other.id } })).toBe(0);
    expect(analysis.userId).not.toBe(other.id);
    expect(await db.profile.count({ where: { userId: null } })).toBe(0); // nothing left quarantined
  });

  it("rejects creating an owner without a password in non-interactive mode", async () => {
    await expect(assignOwner("never-created@example.com")).rejects.toThrow(/password/i);
    expect(await db.user.findUnique({ where: { email: "never-created@example.com" } })).toBeNull();
  });

  it("normalizes the email before lookup/create", async () => {
    const a = await assignOwner("  CaseMix@Example.COM ", "password-123");
    const row = await db.user.findUniqueOrThrow({ where: { email: "casemix@example.com" } });
    expect(row.id).toBe(a.user.id);
  });
});
