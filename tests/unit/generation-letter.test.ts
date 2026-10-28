import { describe, expect, it } from "vitest";
import type { EvidenceRef, MatchReport, RequirementMatch } from "@/lib/jobs/schemas";
import { buildLetterPlan, LETTER_MAX_WORDS, type PinnedSnapshot } from "@/lib/generation/plan";
import { buildLetterTaskPayload, mergeKeyedLetterDraft } from "@/lib/generation/draft";
import { checkLetterComplementarity } from "@/lib/generation/factguard";
import { fitLetterToBudget } from "@/lib/generation/fit";
import { renderLetter } from "@/lib/generation/render/letter";
import { letterClaimId, type CoverLetterContent, type GenerationSettings } from "@/lib/generation/schemas";

// Letter-pipeline fixtures (US6): plan → keyed draft → complementarity check → 1-page fit.

function bullet(id: string, text: string) {
  return { id, text, order: 0, confidence: 0.9, containmentOk: true };
}

function snapshotFixture(): PinnedSnapshot {
  return {
    id: "p1",
    version: 4,
    language: "en",
    basics: { name: "Camille Durand", email: "camille@example.com", phone: "+1 514 555 0100", links: [] },
    experience: [
      {
        id: "e1",
        company: "Acme",
        title: "Platform Engineer",
        location: null,
        startDate: "2021-01",
        endDate: "present",
        skillsUsed: ["Go", "Kubernetes"],
        order: 0,
        bullets: [bullet("b1", "Operated Kubernetes clusters serving 2M requests per day."), bullet("b2", "Led a team of 5 engineers.")],
      },
      {
        id: "e2",
        company: "Globex",
        title: "Backend Developer",
        location: null,
        startDate: "2018-01",
        endDate: "2020-12",
        skillsUsed: [],
        order: 1,
        bullets: [bullet("b3", "Built REST APIs in Go.")],
      },
    ],
    education: [],
    skills: [{ id: "s1", name: "Kubernetes" }],
    languages: [],
    projects: [],
    certifications: [],
  } as unknown as PinnedSnapshot;
}

function requirement(o: {
  id: string;
  text: string;
  status?: RequirementMatch["status"];
  method?: RequirementMatch["matchMethod"];
  evidence?: EvidenceRef[];
}): RequirementMatch {
  return {
    id: o.id,
    text: o.text,
    importance: "must",
    isHardConstraint: false,
    status: o.status ?? "strong",
    matchMethod: o.method ?? "exact",
    evidence: o.evidence ?? [],
    note: null,
  };
}

function reportFixture(): MatchReport {
  return {
    overallScore: 60,
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
    requirements: [
      requirement({ id: "r1", text: "Kubernetes", evidence: [{ type: "skill", id: "s1", snippet: "Kubernetes" }, { type: "bullet", id: "e1", snippet: "Platform Engineer — Acme" }] }),
    ],
    recommendedKeywords: ["Kubernetes"],
    missingKeywords: [],
    semanticDropped: 0,
  };
}

const settings = (over: Partial<GenerationSettings> = {}): GenerationSettings => ({
  outputLanguage: "en",
  pageBudget: 1,
  tone: "professional",
  summaryMaxWords: 60,
  ...over,
});

describe("buildLetterPlan (deterministic, angle-keyed)", () => {
  it("builds motivation → fit → achievement paragraphs with keys letter.{n} and resolvable evidence", () => {
    const plan = buildLetterPlan({ snapshot: snapshotFixture(), report: reportFixture(), now: new Date("2026-10-24T00:00:00Z") });
    expect(plan.kind).toBe("letter");
    expect(plan.items.map((i) => i.angle)).toEqual(["motivation", "fit", "achievement"]);
    expect(plan.items.map((i) => i.key)).toEqual([letterClaimId(1), letterClaimId(2), letterClaimId(3)]);
    expect(plan.maxWords).toBe(LETTER_MAX_WORDS);

    // every item cites evidence ids that resolve in the pinned snapshot
    const snapshotIds = new Set(["e1", "e2", "b1", "b2", "b3", "s1"]);
    for (const item of plan.items) {
      expect(item.evidence.length).toBeGreaterThan(0);
      for (const ref of item.evidence) expect(snapshotIds.has(ref.id)).toBe(true);
      expect(item.sourceText.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic: identical inputs produce the identical plan", () => {
    const args = { snapshot: snapshotFixture(), report: reportFixture(), now: new Date("2026-10-24T00:00:00Z") };
    expect(buildLetterPlan(args)).toEqual(buildLetterPlan(args));
  });

  it("drops angles without evidence (no matched requirements ⇒ no fit paragraph)", () => {
    const empty: MatchReport = { ...reportFixture(), requirements: [] };
    const plan = buildLetterPlan({ snapshot: snapshotFixture(), report: empty });
    expect(plan.items.map((i) => i.angle)).not.toContain("fit");
  });
});

describe("mergeKeyedLetterDraft (keyed merge, R7 rules)", () => {
  const plan = buildLetterPlan({ snapshot: snapshotFixture(), report: reportFixture(), now: new Date("2026-10-24T00:00:00Z") });

  it("attaches the plan's evidence to each paragraph; unkeyed output is dropped", () => {
    const key = plan.items[0]!.key;
    const { content, warnings } = mergeKeyedLetterDraft(plan, {
      paragraphs: [
        { key, text: "I am excited to apply for this role." },
        { key: "letter.99", text: "unkeyed junk" },
      ],
    });
    expect(content.paragraphs).toHaveLength(1);
    expect(content.paragraphs[0]!.claimId).toBe(key);
    expect(content.paragraphs[0]!.text).toBe("I am excited to apply for this role.");
    expect(content.paragraphs[0]!.evidence.map((e) => e.id)).toEqual(plan.items[0]!.evidence.map((e) => e.id));
    expect(warnings).toHaveLength(0);
    expect(content.tone).toBe("professional");
  });

  it("omits skipped angles with omission entries (letters never verbatim-fallback)", () => {
    const { content, warnings } = mergeKeyedLetterDraft(plan, { paragraphs: [] });
    expect(content.paragraphs).toHaveLength(0);
    expect(content.omissions).toHaveLength(plan.items.length);
    expect(content.omissions.every((o) => o.reason === "unwritten" && o.type === "letter_paragraph")).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("surfaces uncertainTranslations as warnings on known keys only", () => {
    const { warnings } = mergeKeyedLetterDraft(plan, {
      paragraphs: plan.items.map((i) => ({ key: i.key, text: `draft ${i.key}` })),
      uncertainTranslations: [{ key: plan.items[0]!.key, note: "credential name" }, { key: "letter.99", note: "unknown" }],
    });
    expect(warnings.filter((w) => w.code === "UNCERTAIN_TRANSLATION")).toHaveLength(1);
  });
});

describe("checkLetterComplementarity (LETTER_DUPLICATES_CV, deterministic)", () => {
  it("flags a paragraph that verbatim-reuses a CV bullet", () => {
    const cvTexts = ["Operated Kubernetes clusters serving 2M requests per day."];
    const flags = checkLetterComplementarity(
      [{ claimId: "letter.1", text: "Operated Kubernetes clusters serving 2M requests per day." }],
      cvTexts,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ code: "LETTER_DUPLICATES_CV", claim: "letter.1", severity: "blocker" });
  });

  it("does not flag clearly distinct paragraphs or run against an absent CV", () => {
    const cvTexts = ["Operated Kubernetes clusters serving 2M requests per day."];
    expect(checkLetterComplementarity([{ claimId: "letter.1", text: "I want to bring my platform experience to your team." }], cvTexts)).toHaveLength(0);
    expect(checkLetterComplementarity([{ claimId: "letter.1", text: "Anything at all." }], [])).toHaveLength(0);
  });
});

describe("buildLetterTaskPayload (tone + language + anti-repetition input)", () => {
  it("carries tone, outputLanguage, cvBulletTexts, and the 320-word cap", () => {
    const plan = buildLetterPlan({ snapshot: snapshotFixture(), report: reportFixture() });
    const payload = buildLetterTaskPayload(plan, settings({ tone: "enthusiastic", outputLanguage: "fr" }), ["cv bullet text"]);
    expect(payload.outputLanguage).toBe("fr");
    expect(payload.tone).toBe("enthusiastic");
    expect(payload.cvBulletTexts).toEqual(["cv bullet text"]);
    expect(payload.maxWords).toBe(320);
    expect(payload.paragraphs.map((p) => p.angle)).toEqual(["motivation", "fit", "achievement"]);
  });
});

describe("fitLetterToBudget (fixed 1 page, paragraphs as demotion unit)", () => {
  const snapshot = snapshotFixture();
  const plan = buildLetterPlan({ snapshot, report: reportFixture() });

  function letterContent(texts: string[]): CoverLetterContent {
    return {
      claimIdVersion: 1,
      paragraphs: texts.map((text, index) => ({
        claimId: letterClaimId(index + 1),
        text,
        evidence: plan.items[index % plan.items.length]!.evidence,
      })),
      tone: "professional",
      omissions: [],
    };
  }

  it("fits within one page without demotion for a normal letter", async () => {
    const content = letterContent(["Short opening paragraph.", "Fit paragraph.", "Closing paragraph."]);
    const fit = await fitLetterToBudget({ content, plan, snapshot, settings: settings() });
    expect(fit.pageCount).toBe(1);
    expect(fit.content.omissions).toHaveLength(0);
    expect(fit.content.paragraphs).toHaveLength(3);
  });

  it("demotes paragraphs (lowest plan score first) until the letter fits, recording omissions", async () => {
    // ~3.4k chars: two such paragraphs overflow one page, one fits — so the
    // loop demotes motivation then fit and lands on the achievement paragraph
    const long = "A very long paragraph. ".repeat(150).trim();
    const content = letterContent([long, long, long]);
    const fit = await fitLetterToBudget({ content, plan, snapshot, settings: settings() });
    expect(fit.pageCount).toBeLessThanOrEqual(1);
    expect(fit.content.paragraphs.length).toBeLessThan(3);
    expect(fit.content.omissions.length).toBe(3 - fit.content.paragraphs.length);
    expect(fit.content.omissions.every((o) => o.reason === "page_budget" && o.type === "letter_paragraph")).toBe(true);
    // demotion order: the lowest-scored plan paragraph goes first
    const scores = plan.items.map((i) => i.score);
    const firstDemoted = fit.content.omissions[0]!.id;
    const minIndex = scores.indexOf(Math.min(...scores));
    expect(firstDemoted).toBe(letterClaimId(minIndex + 1));
  });

  it("fails with PAGE_BUDGET_CONFLICT when a single paragraph still overflows", async () => {
    const huge = "Unfittable. ".repeat(2000).trim();
    const content = letterContent([huge]);
    await expect(fitLetterToBudget({ content, plan, snapshot, settings: settings() })).rejects.toMatchObject({
      code: "PAGE_BUDGET_CONFLICT",
    });
  });
});

describe("renderLetter + plain text", () => {
  it("renders a single-column letter (name, contact, paragraphs) and exposes plain text", async () => {
    const plan = buildLetterPlan({ snapshot: snapshotFixture(), report: reportFixture() });
    const { content } = mergeKeyedLetterDraft(plan, {
      paragraphs: plan.items.map((i, n) => ({ key: i.key, text: `Paragraph ${n + 1} about the role.` })),
    });
    const rendered = await renderLetter({ content, snapshot: snapshotFixture(), settings: settings() });
    expect(rendered.pageCount).toBe(1);
    expect(rendered.bytes.byteLength).toBeGreaterThan(0);
  });
});
