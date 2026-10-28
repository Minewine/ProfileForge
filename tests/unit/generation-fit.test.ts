import { describe, expect, it } from "vitest";
import { fitCVToBudget } from "@/lib/generation/fit";
import { buildCVPlan, type PinnedSnapshot } from "@/lib/generation/plan";
import { mergeKeyedDraft } from "@/lib/generation/draft";
import type { EvidenceRef, MatchReport, RequirementMatch } from "@/lib/jobs/schemas";
import type { CVPlan } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings, Omission } from "@/lib/generation/schemas";

// T029 — measure-and-demote fitting (FR-003, research R9): render → count
// pages → demote the lowest-scored demotable (whole entry before its bullets)
// into omissions with reason "page_budget"; must-include never demoted;
// PAGE_BUDGET_CONFLICT when nothing demotable remains; no fixed quotas.

const NOW = new Date("2026-01-01T00:00:00Z");

function bullet(id: string, index: number, text = "Réalisation mesurable avec des résultats concrets et vérifiables.") {
  return { id, text, order: index, confidence: 0.9, containmentOk: true };
}

function experienceFixture(o: {
  id: string;
  company: string;
  bullets: number;
  start?: string;
  end?: string | null;
}) {
  return {
    id: o.id,
    company: o.company,
    title: `Engineer ${o.id}`,
    location: null,
    startDate: o.start ?? "2020-01",
    endDate: o.end === undefined ? "2024-06" : o.end,
    skillsUsed: [] as string[],
    order: 0,
    bullets: Array.from({ length: o.bullets }, (_, i) => bullet(`${o.id}-b${i + 1}`, i)),
  };
}

type SnapshotExperience = ReturnType<typeof experienceFixture>;

function snapshotFixture(experience: SnapshotExperience[]): PinnedSnapshot {
  return {
    id: "p1",
    version: 2,
    language: "fr",
    basics: { name: "Camille Durand", email: "camille@example.fr", phone: null, links: [], location: null },
    experience,
    education: [],
    skills: [],
    languages: [],
    projects: [],
    certifications: [],
  } as unknown as PinnedSnapshot;
}

function reportFixture(evidenceFor: string[]): MatchReport {
  const requirement = (id: string, evidence: EvidenceRef[]): RequirementMatch => ({
    id,
    text: "Kubernetes and distributed systems experience",
    importance: "must",
    isHardConstraint: true,
    status: "strong",
    matchMethod: "exact",
    evidence,
    note: null,
  });
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
    requirements: evidenceFor.length
      ? [requirement("r1", evidenceFor.map((id) => ({ type: "bullet" as const, id, snippet: "evidence" })))]
      : [],
    recommendedKeywords: ["Kubernetes"],
    missingKeywords: [],
    semanticDropped: 0,
  };
}

/** Draft the plan's items verbatim through the real keyed merge (no LLM). */
function draftContent(plan: CVPlan, summary = "Ingénieure senior en systèmes distribués."): GeneratedCVContent {
  const { content } = mergeKeyedDraft(plan, {
    summary,
    items: plan.items.map((i) => ({ key: i.key, text: i.sourceText.join(" ") })),
  });
  return content;
}

// shared scenario: a weak old entry e1 + a strong current entry e2 whose first
// bullet carries MatchReport evidence (e2 outranks e1 on every signal).
function scenario(e2Bullets: number) {
  const snapshot = snapshotFixture([
    experienceFixture({ id: "e1", company: "Old Corp", bullets: 20, start: "2005-01", end: "2009-12" }),
    experienceFixture({ id: "e2", company: "Strong Corp", bullets: e2Bullets, start: "2020-01", end: null }),
  ]);
  const planFor = (restored: Omission[] = []) =>
    buildCVPlan({
      snapshot,
      report: reportFixture([snapshot.experience[1].bullets[0].id]),
      restoredOmissions: restored,
      now: NOW,
    });
  const fit = (content: GeneratedCVContent, plan: CVPlan, pageBudget: number) =>
    fitCVToBudget({
      content,
      plan,
      snapshot,
      settings: { outputLanguage: "fr", pageBudget, tone: "professional", summaryMaxWords: 60 } satisfies GenerationSettings,
    });
  return { snapshot, planFor, fit };
}

describe("fitCVToBudget", () => {
  it("demotes the lowest-scored demotable whole entry (with its bullets) into page_budget omissions", async () => {
    // 20 + 35 bullets overflow one page; the strong 35-bullet entry alone fits
    const { planFor, fit } = scenario(35);
    const plan = planFor();
    const content = draftContent(plan);
    const over = await fit(content, plan, 3);
    expect(over.pageCount).toBeGreaterThan(1); // the fixture genuinely overflows a generous budget

    const outcome = await fit(content, plan, 1);
    expect(outcome.pageCount).toBeLessThanOrEqual(1);
    // the whole weak entry went — not a per-bullet quota
    expect(outcome.content.omissions).toContainEqual({ type: "experience", id: "e1", reason: "page_budget" });
    // the strong entry survives intact (whole entry before its bullets)
    expect(outcome.content.experience.map((e) => e.id)).toEqual(["e2"]);
    expect(outcome.content.experience[0].bullets).toHaveLength(35);
    expect(
      outcome.content.omissions.filter((o) => o.type === "experience_bullet" && o.id.startsWith("exp.e2.")),
    ).toHaveLength(0);
  });

  it("never demotes must-include items and falls through to the next demotable unit", async () => {
    // restore one e2 bullet → must-include: e2 becomes undemotable as a whole,
    // so fitting demotes the weak e1 entry, then e2's non-must bullets.
    const { snapshot, planFor, fit } = scenario(60);
    const mustBulletId = snapshot.experience[1].bullets[0].id;
    const plan = planFor([{ type: "experience_bullet", id: mustBulletId, reason: "page_budget", restoredMustInclude: true }]);
    const content = draftContent(plan);
    const outcome = await fit(content, plan, 1);

    expect(outcome.pageCount).toBeLessThanOrEqual(1);
    // weak demotable entry still went whole first
    expect(outcome.content.omissions).toContainEqual({ type: "experience", id: "e1", reason: "page_budget" });
    // the must-include bullet survived everything
    const mustBullet = outcome.content.experience
      .flatMap((e) => e.bullets)
      .find((b) => b.sourceBulletIds.includes(mustBulletId));
    expect(mustBullet).toBeDefined();
    expect(outcome.content.omissions.some((o) => o.id === mustBullet!.claimId)).toBe(false);
    // whatever else was demoted came out as individual bullets, never the must-include
    expect(outcome.content.omissions.some((o) => o.type === "experience_bullet")).toBe(true);
    for (const omission of outcome.content.omissions) {
      expect(omission.reason).toBe("page_budget");
      expect(omission.id).not.toBe(mustBullet!.claimId);
    }
  });

  it("fails PAGE_BUDGET_CONFLICT when the must-include set alone exceeds the budget (pre-check, R9)", async () => {
    // every e2 bullet restored → must-include; 60 bullets cannot fit one page
    const { planFor, fit } = scenario(60);
    const plan = planFor([{ type: "experience", id: "e2", reason: "page_budget", restoredMustInclude: true }]);
    const content = draftContent(plan);
    await expect(fit(content, plan, 1)).rejects.toMatchObject({ code: "PAGE_BUDGET_CONFLICT" });
  });

  it("fails PAGE_BUDGET_CONFLICT when nothing demotable remains and the render is still over budget", async () => {
    const snapshot = snapshotFixture([]);
    const plan = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW });
    const hugeSummary = "Ingénieure senior. ".repeat(400); // far beyond one page
    const content = draftContent(plan, hugeSummary);
    await expect(
      fitCVToBudget({
        content,
        plan,
        snapshot,
        settings: { outputLanguage: "fr", pageBudget: 1, tone: "professional", summaryMaxWords: 60 },
      }),
    ).rejects.toMatchObject({ code: "PAGE_BUDGET_CONFLICT" });
  });

  it("keeps everything (empty omissions) when the content already fits the budget", async () => {
    const snapshot = snapshotFixture([experienceFixture({ id: "e1", company: "Corp", bullets: 3 })]);
    const plan = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW });
    const content = draftContent(plan);
    const outcome = await fitCVToBudget({
      content,
      plan,
      snapshot,
      settings: { outputLanguage: "fr", pageBudget: 2, tone: "professional", summaryMaxWords: 60 },
    });

    expect(outcome.content.omissions).toEqual([]); // present but empty — no hidden truncation
    expect(outcome.content).toEqual(content);
    expect(outcome.pageCount).toBeLessThanOrEqual(2);
  });

  it("never demotes restored skill omissions — must-include skills survive Tier 3 (SC-006)", async () => {
    // 400 skills overflow one page on their own → Tier-3 demotes from the list
    // end; the restored skill sits deep enough that it would normally go.
    const snapshot = snapshotFixture([]);
    const skills = Array.from({ length: 400 }, (_, i) => `Skill name number ${i}`);
    const restored = "Skill name number 300";
    const plan: CVPlan = {
      ...buildCVPlan({ snapshot, report: reportFixture([]), now: NOW }),
      skills,
      mustIncludeSkills: [restored],
    };
    const content = draftContent(plan);

    const outcome = await fitCVToBudget({
      content,
      plan,
      snapshot,
      settings: { outputLanguage: "fr", pageBudget: 1, tone: "professional", summaryMaxWords: 60 },
    });

    expect(outcome.pageCount).toBeLessThanOrEqual(1);
    expect(outcome.content.skills).toContain(restored); // survived as must-include
    expect(outcome.content.omissions.some((o) => o.type === "skill" && o.id === restored)).toBe(false);
    expect(outcome.content.omissions.some((o) => o.type === "skill")).toBe(true); // non-restored skills still demote
  });
});
