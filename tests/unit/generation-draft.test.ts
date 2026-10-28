import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCVPlan, type CVPlan, type CVPlanItem, type PinnedSnapshot } from "@/lib/generation/plan";
import { GeneratedCVContentSchema, type GenerationSettings } from "@/lib/generation/schemas";
import {
  buildTaskPayload,
  draftCV,
  mergeKeyedDraft,
  verbatimFallbackText,
  type TailoredCVOutput,
} from "@/lib/generation/draft";
import type { MatchReport } from "@/lib/jobs/schemas";

vi.mock("@/lib/llm/router", () => ({
  callLLM: vi.fn(),
  registerTask: vi.fn(),
  resetTaskRegistry: vi.fn(),
  OPENROUTER_URL: "x",
}));

function item(o: Partial<CVPlanItem> & { key: string; kind: CVPlanItem["kind"]; entryId: string }): CVPlanItem {
  return {
    sourceText: [`${o.key} source text`],
    sourceIds: [`${o.entryId}-source`],
    entryMeta: { title: "Engineer", company: "Acme", dates: "2021-01 – present" },
    evidence: [],
    score: 1,
    entryScore: 1,
    mustInclude: false,
    ...o,
  };
}

function planFixture(items: CVPlanItem[], overrides: Partial<CVPlan> = {}): CVPlan {
  return {
    kind: "cv",
    items,
    skills: ["Kubernetes"],
    summarySources: items.map((i) => i.sourceText[0]),
    summaryEvidence: [
      { type: "bullet", id: items[0]?.sourceIds[0] ?? "b1", snippet: items[0]?.sourceText[0] ?? "src" },
    ],
    summaryRequirements: [],
    jdDigest: { role: null, keywords: ["Kubernetes"] },
    mustIncludeKeys: [],
    ...overrides,
  };
}

const OUTPUT: TailoredCVOutput = {
  summary: "Platform engineer with Kubernetes depth.",
  items: [{ key: "exp.e1.1", text: "Tailored bullet text.", rationale: "jd-critical" }],
};

describe("mergeKeyedDraft (R7 keyed merge)", () => {
  it("attaches provenance from the plan — never from the LLM", () => {
    const plan = planFixture([
      item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] }),
      item({ key: "edu.ed1", kind: "education", entryId: "ed1", sourceIds: ["ed1"] }),
    ]);
    const { content } = mergeKeyedDraft(plan, {
      ...OUTPUT,
      items: [
        { key: "exp.e1.1", text: "Tailored bullet text.", rationale: "jd-critical" },
        { key: "edu.ed1", text: "BSc Computer Science at McGill." },
      ],
    });
    expect(content.experience).toEqual([
      {
        id: "e1",
        bullets: [
          { claimId: "exp.e1.1", text: "Tailored bullet text.", sourceBulletIds: ["b1"], rationale: "jd-critical" },
        ],
      },
    ]);
    expect(content.education).toEqual([
      { id: "ed1", claimId: "edu.ed1", text: "BSc Computer Science at McGill.", sourceIds: ["ed1"] },
    ]);
    expect(GeneratedCVContentSchema.safeParse(content).success).toBe(true);
  });

  it("drops unkeyed LLM items — the LLM can never introduce a claim", () => {
    const plan = planFixture([item({ key: "exp.e1.1", kind: "experience", entryId: "e1" })]);
    const { content } = mergeKeyedDraft(plan, {
      ...OUTPUT,
      items: [
        { key: "exp.e1.1", text: "Tailored bullet text." },
        { key: "exp.nowhere.9", text: "Invented content." },
        { key: "totally-bogus", text: "Also invented." },
      ],
    });
    expect(content.experience).toHaveLength(1);
    expect(JSON.stringify(content)).not.toContain("Invented content.");
    expect(JSON.stringify(content)).not.toContain("Also invented.");
  });

  it("missing keys fall back to verbatim source text with a VERBATIM_FALLBACK warning", () => {
    const plan = planFixture([
      item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceText: ["First source"], sourceIds: ["b1"] }),
      item({ key: "exp.e1.2", kind: "experience", entryId: "e1", sourceText: ["Second source"], sourceIds: ["b2"] }),
      item({ key: "edu.ed1", kind: "education", entryId: "ed1", sourceText: ["BSc", "McGill"], sourceIds: ["ed1"] }),
    ]);
    const { content, warnings } = mergeKeyedDraft(plan, OUTPUT); // only exp.e1.1 covered

    const bullets = content.experience[0].bullets;
    expect(bullets[1]).toEqual({ claimId: "exp.e1.2", text: "Second source", sourceBulletIds: ["b2"] });
    expect(content.education[0].text).toBe(verbatimFallbackText(["BSc", "McGill"]));
    expect(warnings).toContainEqual({
      code: "VERBATIM_FALLBACK",
      claim: "exp.e1.2",
      severity: "warning",
      resolution: "pending",
    });
    expect(warnings).toContainEqual({ code: "VERBATIM_FALLBACK", claim: "edu.ed1", severity: "warning", resolution: "pending" });
    expect(warnings).not.toContainEqual(expect.objectContaining({ claim: "exp.e1.1" }));
  });

  it("summary carries summaryProvenance from the plan", () => {
    const plan = planFixture([item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] })]);
    const { content } = mergeKeyedDraft(plan, OUTPUT);
    expect(content.summary).toBe("Platform engineer with Kubernetes depth.");
    expect(content.summaryProvenance).toEqual([{ type: "bullet", id: "b1", snippet: "exp.e1.1 source text" }]);
  });

  it("empty LLM summary falls back to the first summary source with a warning on claim 'summary'", () => {
    const plan = planFixture([item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceText: ["Lead source"] })]);
    const { content, warnings } = mergeKeyedDraft(plan, { ...OUTPUT, summary: "   " });
    expect(content.summary).toBe("Lead source");
    expect(warnings).toContainEqual({ code: "VERBATIM_FALLBACK", claim: "summary", severity: "warning", resolution: "pending" });
  });

  it("passes the deterministic skills list through untouched and keeps omissions present but empty", () => {
    const plan = planFixture([item({ key: "exp.e1.1", kind: "experience", entryId: "e1" })], { skills: ["Kubernetes", "Go"] });
    const { content } = mergeKeyedDraft(plan, OUTPUT);
    expect(content.skills).toEqual(["Kubernetes", "Go"]);
    expect(content.omissions).toEqual([]);
  });

  it("maps keyed uncertainTranslations to UNCERTAIN_TRANSLATION warnings and drops unknown keys", () => {
    const plan = planFixture([item({ key: "exp.e1.1", kind: "experience", entryId: "e1" })]);
    const { warnings } = mergeKeyedDraft(plan, {
      ...OUTPUT,
      uncertainTranslations: [
        { key: "exp.e1.1", note: "proper noun could not be mapped faithfully" },
        { key: "unknown-key", note: "dropped" },
      ],
    });
    expect(warnings).toContainEqual({
      code: "UNCERTAIN_TRANSLATION",
      claim: "exp.e1.1",
      severity: "warning",
      resolution: "pending",
    });
    expect(warnings).not.toContainEqual(expect.objectContaining({ claim: "unknown-key" }));
  });
});

describe("draftCV (LLM call)", () => {
  beforeEach(async () => {
    vi.mocked((await import("@/lib/llm/router")).callLLM).mockReset();
  });

  it("sends the payload-minimized generateTailoredCV task and merges the keyed result", async () => {
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: OUTPUT,
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
      modelUsed: "test/premium",
    } as never);

    const plan = planFixture([
      item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] }),
      item({ key: "cert.c1", kind: "certification", entryId: "c1", sourceIds: ["c1"] }),
    ]);
    const settings: GenerationSettings = { outputLanguage: "fr", pageBudget: 2, tone: "professional", summaryMaxWords: 60, notes: "mette en avant Go" };
    const checkCancelled = vi.fn().mockResolvedValue(undefined);

    const { content, warnings } = await draftCV({
    userId: "u-test", plan, settings, runId: "run-1", checkCancelled });

    expect(checkCancelled).toHaveBeenCalledTimes(1); // cancel check before the LLM call
    expect(vi.mocked(callLLM)).toHaveBeenCalledWith({
      userId: "u-test",
      task: "generateTailoredCV",
      runId: "run-1",
      payload: {
        outputLanguage: "fr",
        notes: "mette en avant Go",
        plan: [
          { key: "exp.e1.1", kind: "experience", sourceText: ["exp.e1.1 source text"], entryMeta: { title: "Engineer", company: "Acme", dates: "2021-01 – present" } },
          { key: "cert.c1", kind: "certification", sourceText: ["cert.c1 source text"], entryMeta: { title: "Engineer", company: "Acme", dates: "2021-01 – present" } },
        ],
        skills: ["Kubernetes"],
        summarySources: ["exp.e1.1 source text", "cert.c1 source text"],
        summaryRequirements: [],
        summaryMaxWords: 60,
        jdDigest: { keywords: ["Kubernetes"] },
        pageBudget: 2,
      },
    });
    // payload minimization: no score/evidence/mustInclude leaked to the LLM
    const payload = vi.mocked(callLLM).mock.calls[0][0].payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('"score"');
    expect(JSON.stringify(payload)).not.toContain('"evidence"');

    expect(content.experience[0].bullets[0].text).toBe("Tailored bullet text.");
    expect(warnings).toContainEqual(expect.objectContaining({ code: "VERBATIM_FALLBACK", claim: "cert.c1" }));
  });

  it("skips the LLM entirely when the plan has no items (empty pinned snapshot)", async () => {
    const { callLLM } = await import("@/lib/llm/router");
    const plan = planFixture([], { summarySources: [], summaryEvidence: [] });
    const { content } = await draftCV({
    userId: "u-test",
      plan,
      settings: { outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 60 },
      runId: "run-2",
      checkCancelled: vi.fn(),
    });
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
    expect(content.experience).toEqual([]);
    expect(content.summary).toBe("");
    expect(content.skills).toEqual(["Kubernetes"]);
    expect(GeneratedCVContentSchema.safeParse(content).success).toBe(true);
  });
});


// Review regression (P0): pipeline-built payloads must satisfy the REAL task
// input schemas — callLLM validates payloads before prompting and every other
// test mocks it, so these parses are the only guard against schema drift.
describe("task payload schema conformance (review regression)", () => {
  it("the CV payload parses against GenerateTailoredCVInputSchema", async () => {
    const { GenerateTailoredCVInputSchema } = await import("@/lib/llm/tasks/generatetailoredcv");
    const { buildTaskPayload } = await import("@/lib/generation/draft");
    const plan = planFixture([item({ key: "exp.e1.1", kind: "experience", entryId: "e1" })]);
    const payload = buildTaskPayload(plan, {
      outputLanguage: "en",
      pageBudget: 2,
      tone: "professional",
      summaryMaxWords: 60,
    });
    expect(GenerateTailoredCVInputSchema.parse(payload)).toBeDefined();
  });

  it("the letter payload parses against GenerateCoverLetterInputSchema — role null is omitted (P0)", async () => {
    const { GenerateCoverLetterInputSchema } = await import("@/lib/llm/tasks/generatecoverletter");
    const letterPlanModule = await import("@/lib/generation/plan");
    const { buildLetterTaskPayload } = await import("@/lib/generation/draft");
    const plan: import("@/lib/generation/plan").LetterPlan = {
      kind: "letter",
      items: [
        { key: "letter.1", angle: "motivation", sourceText: ["Platform Engineer — Acme"], evidence: [], score: 0.3 },
      ],
      jdDigest: { role: null, keywords: ["Kubernetes"], topRequirements: ["Kubernetes"] },
      maxWords: letterPlanModule.LETTER_MAX_WORDS,
    };
    const payload = buildLetterTaskPayload(
      plan,
      { outputLanguage: "en", pageBudget: 1, tone: "professional", summaryMaxWords: 60 },
      ["cv bullet"],
    );
    // The contract regression: a null role must be absent, not present as null.
    expect(payload).not.toHaveProperty("jdDigest.role");
    expect(GenerateCoverLetterInputSchema.parse(payload)).toBeDefined();
  });

  it("the factGuard payload parses against FactGuardInputSchema", async () => {
    const { FactGuardInputSchema } = await import("@/lib/llm/tasks/factguard");
    const payload = {
      outputLanguage: "en",
      claims: [{ claimId: "summary", text: "Experienced platform engineer.", evidenceText: ["10 years of platforms."] }],
    };
    expect(FactGuardInputSchema.parse(payload)).toBeDefined();
  });
});

// --- US2 (feature 005): title plan items merge into experience[].title ---

describe("title rewriting (feature 005 US2)", () => {
  it("a title-kind plan item sets experience[].title with the claim id and sourceTitle", () => {
    const plan = planFixture([
      item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] }),
      item({ key: "expTitle.e1", kind: "title", entryId: "e1", sourceText: ["Platform Engineer"], sourceIds: ["e1"] }),
    ]);
    const { content } = mergeKeyedDraft(plan, {
      summary: "s",
      items: [
        { key: "exp.e1.1", text: "Tailored bullet." },
        { key: "expTitle.e1", text: "Platform Engineer — Kubernetes focus" },
      ],
    });
    expect(content.experience[0]?.title).toEqual({
      claimId: "expTitle.e1",
      text: "Platform Engineer — Kubernetes focus",
      sourceTitle: "Platform Engineer",
    });
    expect(content.experience[0]?.bullets[0]?.text).toBe("Tailored bullet.");
  });

  it("a skipped title key falls back to the verbatim snapshot title with a VERBATIM_FALLBACK warning", () => {
    const plan = planFixture([
      item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] }),
      item({ key: "expTitle.e1", kind: "title", entryId: "e1", sourceText: ["Platform Engineer"], sourceIds: ["e1"] }),
    ]);
    const { content, warnings } = mergeKeyedDraft(plan, {
      summary: "s",
      items: [{ key: "exp.e1.1", text: "Tailored bullet." }],
    });
    expect(content.experience[0]?.title).toEqual({
      claimId: "expTitle.e1",
      text: "Platform Engineer",
      sourceTitle: "Platform Engineer",
    });
    expect(warnings.filter((w) => w.code === "VERBATIM_FALLBACK" && w.claim === "expTitle.e1")).toHaveLength(1);
  });

  it("unkeyed title items are dropped and old fixtures without titles keep working", () => {
    const plan = planFixture([
      item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] }),
      item({ key: "expTitle.e1", kind: "title", entryId: "e1", sourceText: ["Platform Engineer"], sourceIds: ["e1"] }),
    ]);
    const { content, warnings } = mergeKeyedDraft(plan, {
      summary: "s",
      items: [
        { key: "exp.e1.1", text: "Tailored bullet." },
        { key: "expTitle.e9", text: "unkeyed title" },
      ],
    });
    expect(content.experience[0]?.title?.text).toBe("Platform Engineer"); // fallback, not the unkeyed text
    expect(warnings.filter((w) => w.code === "VERBATIM_FALLBACK")).toHaveLength(1);

    const legacy = mergeKeyedDraft(planFixture([item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] })]), OUTPUT);
    expect(legacy.content.experience[0]?.title).toBeUndefined(); // no title item → no title field
  });

  it("the payload including title items parses against the REAL GenerateTailoredCVInputSchema (P0 lesson)", async () => {
    const { GenerateTailoredCVInputSchema } = await import("@/lib/llm/tasks/generatetailoredcv");
    const { buildTaskPayload } = await import("@/lib/generation/draft");
    const plan = planFixture([
      item({ key: "exp.e1.1", kind: "experience", entryId: "e1", sourceIds: ["b1"] }),
      item({ key: "expTitle.e1", kind: "title", entryId: "e1", sourceText: ["Platform Engineer"], sourceIds: ["e1"] }),
    ]);
    const payload = buildTaskPayload(plan, { outputLanguage: "fr", pageBudget: 2, tone: "professional", summaryMaxWords: 60 });
    expect(GenerateTailoredCVInputSchema.parse(payload)).toBeDefined();
  });
});

// --- US3 (feature 005): summary synthesis inputs thread into the task payload ---

describe("summary synthesis payload (feature 005 US3)", () => {
  /** A minimal snapshot/report pair whose must-haves vary — plans built by the
   *  REAL buildCVPlan so the payload difference is the SC-005 mechanism, not a
   *  hand-set field. */
  function planWithMustHaves(mustHaves: string[]): CVPlan {
    const snapshot = {
      id: "p1",
      version: 1,
      language: "en",
      basics: null,
      experience: [
        {
          id: "e1",
          company: "Acme",
          title: "Engineer",
          location: null,
          startDate: "2021-01",
          endDate: "present",
          skillsUsed: [],
          bullets: [{ id: "b1", text: "Shipped module one", confidence: null, containmentOk: null }],
        },
      ],
      education: [],
      skills: [],
      languages: [],
      projects: [],
      certifications: [],
    } as PinnedSnapshot;
    const report: MatchReport = {
      overallScore: 50,
      scoreBreakdown: {
        hardRequirementsMet: 0,
        preferredRequirementsMet: 0,
        exactMatches: 0,
        aliasMatches: 0,
        semanticMatches: 0,
        hardWeight: 60,
        preferredWeight: 30,
        evidenceBonus: 0,
      },
      requirements: mustHaves.map((text, i) => ({
        id: `r${i}`,
        text,
        importance: "must" as const,
        isHardConstraint: false,
        status: "strong" as const,
        matchMethod: "none" as const,
        evidence: [],
        note: null,
      })),
      recommendedKeywords: [],
      missingKeywords: [],
      semanticDropped: 0,
    };
    return buildCVPlan({ snapshot, report, now: new Date("2026-01-01T00:00:00Z") });
  }

  it("two reports with different must-haves produce different summaryRequirements payloads (SC-005)", () => {
    const settings: GenerationSettings = { outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 60 };
    const a = buildTaskPayload(planWithMustHaves(["Kubernetes", "Go"]), settings);
    const b = buildTaskPayload(planWithMustHaves(["Team leadership", "Kafka"]), settings);
    expect(a.summaryRequirements).toEqual(["Kubernetes", "Go"]);
    expect(b.summaryRequirements).toEqual(["Team leadership", "Kafka"]);
    expect(a).not.toEqual(b); // different jobs against the same profile ⇒ different summary inputs
  });

  it("summaryMaxWords threads into the payload (the bound the prompt enforces)", () => {
    const plan = planWithMustHaves(["Kubernetes"]);
    const at90 = buildTaskPayload(plan, { outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 90 });
    expect(at90.summaryMaxWords).toBe(90);
  });

  it("the payload with summary inputs parses against the REAL GenerateTailoredCVInputSchema", async () => {
    const { GenerateTailoredCVInputSchema } = await import("@/lib/llm/tasks/generatetailoredcv");
    const { buildTaskPayload } = await import("@/lib/generation/draft");
    const payload = buildTaskPayload(planWithMustHaves(["Kubernetes", "Go", "Leadership"]), {
      outputLanguage: "en",
      pageBudget: 2,
      tone: "professional",
      summaryMaxWords: 45,
    });
    expect(GenerateTailoredCVInputSchema.parse(payload)).toBeDefined();
  });
});
