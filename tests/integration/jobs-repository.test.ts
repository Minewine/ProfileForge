import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createAnalysis,
  deleteAnalysis,
  getAnalysis,
  listAnalyses,
  markExtractFailed,
  persistReport,
  replaceRequirements,
  rerunAnalysis,
  storeExtractedRequirements,
  updateLanguage,
} from "@/lib/jobs/repository";
import { ApiError } from "@/lib/api/errors";
import type { MatchReport } from "@/lib/jobs/schemas";
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

async function clean() {
  await db.jobRequirement.deleteMany({});
  await db.jobAnalysis.deleteMany({});
}

let user: SessionUser;

beforeEach(async () => {
  await resetAuth();
  user = await signIn("jobs-repo@example.com");
  await clean();
});

describe("jobs repository", () => {
  it("creates with guards and language detection; lists with score chips", async () => {
    await expect(createAnalysis(user.id, "too short")).rejects.toMatchObject({ code: "JD_TOO_SHORT" });
    await expect(createAnalysis(user.id, "x".repeat(100_001))).rejects.toMatchObject({ code: "JD_TOO_LONG" });

    const { analysis, languageLowConfidence } = await createAnalysis(user.id, JD);
    expect(analysis.status).toBe("created");
    expect(analysis.language).toBe("en");
    expect(languageLowConfidence).toBe(false);

    const listed = await listAnalyses(user.id);
    expect(listed[0]).toMatchObject({ id: analysis.id, status: "created", requirementCount: 0 });
    expect(listed[0].overallScore).toBeNull();
  });

  it("walks the state machine: created → extracted → finalized → matched, with failed retry", async () => {
    const { analysis } = await createAnalysis(user.id, JD);

    const stored = await storeExtractedRequirements(user.id, analysis.id, [
      { text: "Kubernetes", category: "tool", importance: "must", isHardConstraint: true },
      { text: "Kafka", category: "tool", importance: "nice", isHardConstraint: false },
    ]);
    expect(stored.replacedRequirements).toBe(false);
    expect((await getAnalysis(user.id, analysis.id)).status).toBe("extracted");

    // re-extraction replaces the list
    const again = await storeExtractedRequirements(user.id, analysis.id, [
      { text: "Go", category: "skill", importance: "must", isHardConstraint: false },
    ]);
    expect(again.replacedRequirements).toBe(true);
    expect((await getAnalysis(user.id, analysis.id)).requirements).toHaveLength(1);

    const replaced = await replaceRequirements(
      user.id,
      analysis.id,
      [
        { text: "Go", category: "skill", importance: "must", isHardConstraint: false },
        { text: "Rust", category: "skill", importance: "nice", isHardConstraint: false },
      ],
      true,
    );
    expect(replaced.status).toBe("finalized");

    // language locked once matched
    await updateLanguage(user.id, analysis.id, "fr");
    await persistReport(user.id, analysis.id, 7, reportFixture());
    expect((await getAnalysis(user.id, analysis.id)).status).toBe("matched");
    expect((await getAnalysis(user.id, analysis.id)).profileVersion).toBe(7);
    await expect(updateLanguage(user.id, analysis.id, "en")).rejects.toMatchObject({ code: "INVALID_STATE" });

    // failed extraction is retryable
    const other = (await createAnalysis(user.id, JD)).analysis;
    await markExtractFailed(user.id, other.id, "llm down");
    expect((await getAnalysis(user.id, other.id)).status).toBe("failed");
    await storeExtractedRequirements(user.id, other.id, [
      { text: "Go", category: "skill", importance: "must", isHardConstraint: false },
    ]);
    expect((await getAnalysis(user.id, other.id)).status).toBe("extracted");
  });

  it("preserves user confirmations across requirement replaces", async () => {
    const { analysis } = await createAnalysis(user.id, JD);
    await storeExtractedRequirements(user.id, analysis.id, [
      { text: "AWS Certification", category: "education", importance: "must", isHardConstraint: true },
    ]);
    await replaceRequirements(
      user.id,
      analysis.id,
      [{ text: "AWS Certification", category: "education", importance: "must", isHardConstraint: true }],
      true,
    );
    // simulate a confirmation directly (the confirm endpoint writes this)
    const row = (await getAnalysis(user.id, analysis.id)).requirements[0];
    await db.jobRequirement.update({ where: { id: row.id }, data: { userConfirmed: true } });

    await replaceRequirements(
      user.id,
      analysis.id,
      [
        { text: "AWS Certification", category: "education", importance: "must", isHardConstraint: true },
        { text: "Kafka", category: "tool", importance: "nice", isHardConstraint: false },
      ],
      false,
    );
    const after = (await getAnalysis(user.id, analysis.id)).requirements;
    expect(after.find((r) => r.text === "AWS Certification")?.userConfirmed).toBe(true);
    expect(after.find((r) => r.text === "Kafka")?.userConfirmed).toBe(false);
  });

  it("refuses to overwrite a stored report without recompute", async () => {
    const { analysis } = await createAnalysis(user.id, JD);
    await storeExtractedRequirements(user.id, analysis.id, []);
    await replaceRequirements(user.id, analysis.id, [], true);
    await persistReport(user.id, analysis.id, 3, reportFixture({ overallScore: 42 }));
    await expect(persistReport(user.id, analysis.id, 4, reportFixture({ overallScore: 99 }))).rejects.toBeInstanceOf(
      ApiError,
    );
    expect((await getAnalysis(user.id, analysis.id)).matchReport).toMatchObject({ overallScore: 42 });
    await persistReport(user.id, analysis.id, 5, reportFixture({ overallScore: 77 }), { recompute: true });
    expect((await getAnalysis(user.id, analysis.id)).matchReport).toMatchObject({ overallScore: 77 });
  });

  it("re-run chains after match and old report stays unchanged", async () => {
    const { analysis } = await createAnalysis(user.id, JD);
    await storeExtractedRequirements(user.id, analysis.id, [
      { text: "Kubernetes", category: "tool", importance: "must", isHardConstraint: true },
    ]);
    await replaceRequirements(
      user.id,
      analysis.id,
      [{ text: "Kubernetes", category: "tool", importance: "must", isHardConstraint: true }],
      true,
    );
    const reqRow = (await getAnalysis(user.id, analysis.id)).requirements[0];
    await db.jobRequirement.update({ where: { id: reqRow.id }, data: { userConfirmed: true } });
    await persistReport(user.id, analysis.id, 3, reportFixture({ overallScore: 10 }));

    const rerunId = await rerunAnalysis(user.id, analysis.id);
    const rerun = await getAnalysis(user.id, rerunId);
    expect(rerun.status).toBe("finalized");
    expect(rerun.rerunOfId).toBe(analysis.id);
    expect(rerun.requirements[0]).toMatchObject({ text: "Kubernetes", userConfirmed: true });

    // original untouched
    const original = await getAnalysis(user.id, analysis.id);
    expect(original.matchReport).toMatchObject({ overallScore: 10 });
    expect(original.profileVersion).toBe(3);

    // delete cascades
    await deleteAnalysis(user.id, rerunId);
    expect(await db.jobRequirement.count({ where: { analysisId: rerunId } })).toBe(0);
    await expect(getAnalysis(user.id, rerunId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
