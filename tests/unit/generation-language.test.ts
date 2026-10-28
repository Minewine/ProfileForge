import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfPages } from "@/lib/parsing/pdf";
import { normalizeText } from "@/lib/text/normalize";
import type { CVPlan, CVPlanItem, PinnedSnapshot } from "@/lib/generation/plan";
import { PinnedSnapshotSchema } from "@/lib/generation/plan";
import { renderCV } from "@/lib/generation/render/cv";
import { runExtractionGate } from "@/lib/generation/verify";
import { draftCV, mergeKeyedDraft } from "@/lib/generation/draft";
import type { GeneratedCVContent, GenerationSettings } from "@/lib/generation/schemas";
import { resolveGenerationSettings } from "@/lib/generation/schemas";
import type { MatchReport, RequirementMatch } from "@/lib/jobs/schemas";

vi.mock("@/lib/llm/router", () => ({
  callLLM: vi.fn(),
  registerTask: vi.fn(),
  resetTaskRegistry: vi.fn(),
  OPENROUTER_URL: "x",
}));

// T038 — US4 output-language threading (spec FR-015): settings.outputLanguage
// flows plan → draft prompt → renderer heading map (and the extraction gate's
// heading checks) solely from settings — never from the profile or JD
// language. The default is the analysis language; VERBATIM_FALLBACK and
// UNCERTAIN_TRANSLATION surface as warning flags; numeric identity holds for
// FR and EN claim text under the same normalization.

// --- Fixtures ---

function planItem(o: Partial<CVPlanItem> & { key: string; entryId: string }): CVPlanItem {
  return {
    kind: "experience",
    sourceText: [`${o.key} source text`],
    sourceIds: [`${o.entryId}-source`],
    entryMeta: { title: "Platform Engineer", company: "Acme", dates: "2021-01 - present" },
    evidence: [],
    score: 1,
    entryScore: 1,
    mustInclude: false,
    ...o,
  };
}

function planFixture(items: CVPlanItem[]): CVPlan {
  return {
    kind: "cv",
    items,
    skills: ["Kubernetes"],
    summarySources: items.map((i) => i.sourceText[0]),
    summaryEvidence: [{ type: "bullet", id: items[0]?.sourceIds[0] ?? "b1", snippet: "src" }],
    summaryRequirements: [],
    jdDigest: { role: null, keywords: ["Kubernetes"] },
    mustIncludeKeys: [],
  };
}

/** English pinned snapshot; the drafted output below is French (cross-language). */
function snapshotFixture(): PinnedSnapshot {
  return PinnedSnapshotSchema.parse({
    id: "p1",
    version: 3,
    language: "en",
    experience: [
      {
        id: "e1",
        company: "Acme",
        title: "Platform Engineer",
        location: null,
        startDate: "2021-01",
        endDate: "present",
        skillsUsed: [],
        bullets: [
          { id: "b1", text: "Operated Kubernetes clusters serving 2M requests per day.", confidence: 0.9, containmentOk: true },
          { id: "b2", text: "Led a team of 5 engineers.", confidence: 0.8, containmentOk: true },
        ],
      },
    ],
    education: [
      { id: "ed1", institution: "McGill University", degree: "BSc", field: "Computer Science", startDate: null, endDate: null },
    ],
    skills: [{ id: "s1", name: "Kubernetes" }],
    languages: [],
    projects: [],
    certifications: [{ id: "c1", title: "CKA", issuer: "CNCF", issueDate: "2023-04" }],
  });
}

function reportFixture(): MatchReport {
  const requirement: RequirementMatch = {
    id: "r1",
    text: "Kubernetes",
    importance: "must",
    isHardConstraint: true,
    status: "strong",
    matchMethod: "exact",
    evidence: [{ type: "skill", id: "s1", snippet: "Kubernetes" }],
    note: null,
  };
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
    requirements: [requirement],
    recommendedKeywords: ["Kubernetes"],
    missingKeywords: [],
    semanticDropped: 0,
  };
}

const SETTINGS = (outputLanguage: "fr" | "en"): GenerationSettings => ({
  outputLanguage,
  pageBudget: 2,
  tone: "professional",
  summaryMaxWords: 60,
});

beforeEach(async () => {
  vi.mocked((await import("@/lib/llm/router")).callLLM).mockReset();
});

// --- Settings resolution (default = analysis language; explicit override) ---

describe("resolveGenerationSettings (language default + override)", () => {
  it("defaults outputLanguage to the analysis language when unset", () => {
    expect(resolveGenerationSettings({ kind: "cv", analysisLanguage: "fr" })).toMatchObject({
      outputLanguage: "fr",
      pageBudget: 2,
      tone: "professional",
    });
    expect(resolveGenerationSettings({ kind: "cv", analysisLanguage: "en" })).toMatchObject({
      outputLanguage: "en",
    });
  });

  it("an explicit selection overrides regardless of the analysis language", () => {
    expect(
      resolveGenerationSettings({ kind: "cv", analysisLanguage: "fr", input: { outputLanguage: "en" } }),
    ).toMatchObject({ outputLanguage: "en" });
    expect(
      resolveGenerationSettings({ kind: "cv", analysisLanguage: "en", input: { outputLanguage: "fr" } }),
    ).toMatchObject({ outputLanguage: "fr" });
  });
});

// --- Plan → draft prompt threading ---

describe("draft payload threading", () => {
  it("sends settings.outputLanguage to generateTailoredCV — plan/source language never decides", async () => {
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue({
      data: { summary: "Résumé.", items: [] },
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      modelUsed: "test/premium",
    } as never);
    const plan = planFixture([
      planItem({ key: "exp.e1.1", entryId: "e1", sourceText: ["English source text"] }),
    ]);

    // English source text + fr settings → fr payload
    await draftCV({ userId: "u-test", plan, settings: SETTINGS("fr"), runId: "r1", checkCancelled: vi.fn() });
    expect(vi.mocked(callLLM).mock.calls[0][0]).toMatchObject({
      task: "generateTailoredCV",
      payload: { outputLanguage: "fr" },
    });
  });

  it("buildPrompt states the output language to the model in words", async () => {
    const { ensureGenerateTailoredCVRegistered } = await import("@/lib/llm/tasks/generatetailoredcv");
    const { registerTask } = await import("@/lib/llm/router");
    ensureGenerateTailoredCVRegistered();
    const def = vi.mocked(registerTask).mock.calls.at(-1)![0];
    const payload = {
      outputLanguage: "fr" as const,
      plan: [
        {
          key: "exp.e1.1",
          kind: "experience" as const,
          sourceText: ["English source text"],
          entryMeta: { title: "Platform Engineer", company: "Acme", dates: "2021-01 - present" },
        },
      ],
      skills: ["Kubernetes"],
      summarySources: ["English source text"],
      summaryRequirements: [],
      summaryMaxWords: 60,
      jdDigest: { keywords: ["Kubernetes"] },
      pageBudget: 2,
    };
    const messages = def.buildPrompt(payload);
    const user = messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("Output language: French");
    expect(def.buildPrompt({ ...payload, outputLanguage: "en" }).find((m) => m.role === "user")!.content).toContain(
      "Output language: English",
    );
  });
});

// --- Renderer heading map driven solely by settings.outputLanguage ---

describe("renderer headings follow settings.outputLanguage alone", () => {
  function contentFixture(): GeneratedCVContent {
    return {
      claimIdVersion: 1,
      summary: "Ingénieure plateforme avec une expertise Kubernetes.",
      summaryProvenance: [],
      experience: [
        {
          id: "e1",
          bullets: [
            { claimId: "exp.e1.1", text: "Exploitation de clusters Kubernetes pour 2M requêtes par jour.", sourceBulletIds: ["b1"] },
          ],
        },
      ],
      education: [{ id: "ed1", claimId: "edu.ed1", text: "BSc · Computer Science · McGill University", sourceIds: ["ed1"] }],
      projects: [],
      certifications: [{ id: "c1", claimId: "cert.c1", text: "CKA · CNCF", sourceIds: ["c1"] }],
      skills: ["Kubernetes"],
      omissions: [],
    };
  }

  async function extractText(bytes: Uint8Array): Promise<string> {
    const pages = await extractPdfPages(bytes);
    return pages.map((p) => p.text).join("\n");
  }

  it("renders French headings for fr settings over French content", async () => {
    const text = await extractText(
      (await renderCV({ content: contentFixture(), snapshot: snapshotFixture(), settings: SETTINGS("fr") })).bytes,
    );
    for (const heading of ["Résumé professionnel", "Expérience professionnelle", "Formation", "Compétences"]) {
      expect(text).toContain(heading);
    }
    expect(text).not.toContain("Professional Summary");
  });

  it("renders English headings for en settings over the SAME French content — settings alone decide", async () => {
    const text = await extractText(
      (await renderCV({ content: contentFixture(), snapshot: snapshotFixture(), settings: SETTINGS("en") })).bytes,
    );
    for (const heading of ["Professional Summary", "Experience", "Education", "Skills"]) {
      expect(text).toContain(heading);
    }
    expect(text).not.toContain("Résumé professionnel");
  });

  it("the extraction gate checks headings in the settings language (same bytes, different settings ⇒ different outcome)", async () => {
    const snapshot = snapshotFixture();
    const content = contentFixture();
    const bytes = (await renderCV({ content, snapshot, settings: SETTINGS("fr") })).bytes;

    const french = await runExtractionGate({ pdfBytes: bytes, content, snapshot, settings: SETTINGS("fr") });
    expect(french.passed).toBe(true);

    const english = await runExtractionGate({ pdfBytes: bytes, content, snapshot, settings: SETTINGS("en") });
    expect(english.passed).toBe(false); // headings were drawn in French; the en gate expects English
    expect(english.level1.elements.some((e) => e.element.startsWith("heading:") && !e.found)).toBe(true);
  });
});

// --- Translation warnings surface as warning flags (never blockers) ---

describe("translation warnings from the draft merge", () => {
  it("VERBATIM_FALLBACK (skipped key) and UNCERTAIN_TRANSLATION surface as warnings", async () => {
    const plan = planFixture([
      planItem({ key: "exp.e1.1", entryId: "e1", sourceText: ["Operated Kubernetes clusters serving 2M requests per day."], sourceIds: ["b1"] }),
      planItem({ key: "exp.e1.2", entryId: "e1", sourceText: ["Led a team of 5 engineers."], sourceIds: ["b2"] }),
    ]);
    // French draft over English sources: e1.1 translated, e1.2 skipped → verbatim English fallback
    const { warnings } = mergeKeyedDraft(plan, {
      summary: "Ingénieure plateforme avec une expertise Kubernetes de 2M requêtes par jour.",
      items: [{ key: "exp.e1.1", text: "Exploitation de clusters Kubernetes servant 2M requêtes par jour." }],
      uncertainTranslations: [{ key: "exp.e1.1", note: "credential name could not be mapped faithfully" }],
    });
    expect(warnings).toContainEqual({
      code: "VERBATIM_FALLBACK",
      claim: "exp.e1.2",
      severity: "warning",
      resolution: "pending",
    });
    expect(warnings).toContainEqual({
      code: "UNCERTAIN_TRANSLATION",
      claim: "exp.e1.1",
      severity: "warning",
      resolution: "pending",
    });
  });
});

// --- Language-agnostic normalization ---

describe("normalization across languages", () => {
  it("normalizeText is language-agnostic for accented FR metric text", () => {
    expect(normalizeText("Réduction de 60 %")).toContain("60");
    expect(normalizeText("réduction de 60 %")).toBe(normalizeText("Reduction de 60 %"));
  });
});
