import { describe, expect, it } from "vitest";
import type { MatchReport } from "@/lib/jobs/schemas";
import type { GeneratedCVContent, GenerationSettings, SelectionRecord } from "@/lib/generation/schemas";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import {
  computeExtractionGateOk,
  computeOmissionsReasoned,
  computeOutputLanguageOk,
  computePageBudgetOk,
  computeRequirementCoverage,
  computeSelectionIntegrity,
  computeSummaryLengthOk,
  contentText,
  quant4,
} from "@/lib/benchmark/metrics";

const settings: GenerationSettings = {
  outputLanguage: "en",
  pageBudget: 2,
  tone: "professional",
  summaryMaxWords: 60,
  templateId: "ats",
};

const content: GeneratedCVContent = {
  claimIdVersion: 1,
  summary: "Senior backend engineer with deep Go and Kubernetes experience.",
  summaryProvenance: [{ type: "bullet", id: "b1", snippet: "Cut API p95" }],
  experience: [
    {
      id: "exp1",
      title: { claimId: "expTitle.exp1", text: "Senior Backend Engineer", sourceTitle: "Senior Backend Engineer" },
      bullets: [
        { claimId: "exp.exp1.1", text: "Cut API p95 latency by 40%.", sourceBulletIds: ["b1"] },
        { claimId: "exp.exp1.2", text: "Led migration of 40+ services to Kubernetes.", sourceBulletIds: ["b2"] },
      ],
    },
    {
      id: "exp2",
      bullets: [{ claimId: "exp.exp2.1", text: "Built billing services in Go.", sourceBulletIds: ["b3"] }],
    },
  ],
  education: [{ id: "edu1", claimId: "edu.edu1", text: "B.Sc. Computer Science", sourceIds: ["edu1"] }],
  projects: [
    { id: "proj1", bullets: [{ claimId: "proj.proj1.1", text: "Service-mesh toolkit.", sourceBulletIds: ["b4"] }] },
  ],
  certifications: [
    { id: "cert1", claimId: "cert.cert1", text: "CKA — Certified Kubernetes Administrator", sourceIds: ["cert1"] },
  ],
  skills: ["Go", "Kubernetes"],
  omissions: [
    { type: "experience", id: "exp3", reason: "selection" },
    { type: "education", id: "edu2", reason: "page_budget" },
  ],
};

const snapshot = {
  id: "snap1",
  version: 3,
  language: "en",
  experience: [
    { id: "exp1", company: "A", title: "T", location: null, startDate: null, endDate: null, skillsUsed: [], bullets: [] },
    { id: "exp2", company: "B", title: "T", location: null, startDate: null, endDate: null, skillsUsed: [], bullets: [] },
    { id: "exp3", company: "C", title: "T", location: null, startDate: null, endDate: null, skillsUsed: [], bullets: [] },
  ],
  education: [
    { id: "edu1", institution: "U", degree: null, field: null, startDate: null, endDate: null },
    { id: "edu2", institution: "V", degree: null, field: null, startDate: null, endDate: null },
  ],
  skills: [],
  languages: [],
  projects: [{ id: "proj1", name: "P", description: null, startDate: null, endDate: null, bullets: [] }],
  certifications: [{ id: "cert1", title: "CKA", issuer: null, issueDate: null }],
} as unknown as PinnedSnapshot;

function req(overrides: Partial<MatchReport["requirements"][number]> = {}): MatchReport["requirements"][number] {
  return {
    id: "r1",
    text: "Go experience",
    importance: "must",
    isHardConstraint: false,
    status: "strong",
    matchMethod: "exact",
    evidence: [{ type: "bullet", id: "b1", snippet: "Cut API p95" }],
    note: null,
    ...overrides,
  };
}

describe("benchmark metrics", () => {
  it("quantizes to 4 decimal places", () => {
    expect(quant4(1 / 3)).toBe(0.3333);
    expect(quant4(0.123456)).toBe(0.1235);
  });

  it("counts covered requirements against matched requirements", () => {
    const report = {
      requirements: [
        req(), // evidence b1 — cited
        req({ id: "r2", evidence: [{ type: "bullet", id: "b9", snippet: "x" }] }), // not cited
        req({ id: "r3", status: "gap", evidence: [] }), // gap — excluded from the denominator
      ],
    } as unknown as MatchReport;
    const cov = computeRequirementCoverage(report, content);
    expect(cov).toEqual({ covered: 1, total: 2, rate: 0.5 });
  });

  it("counts a full match as 1 and treats no matched requirements as 1", () => {
    const all = { requirements: [req(), req({ id: "r2", evidence: [{ type: "bullet", id: "b3", snippet: "y" }] })] } as unknown as MatchReport;
    expect(computeRequirementCoverage(all, content).rate).toBe(1);
    expect(computeRequirementCoverage({ requirements: [] } as unknown as MatchReport, content).rate).toBe(1);
  });

  it("selection integrity holds when every snapshot entry is included or omitted", () => {
    const selection = {
      included: [
        { entryId: "exp1", kind: "experience", rank: 1, score: 5, basis: { evidenceRefs: [], methodCredits: ["exact"], recency: 1 } },
        { entryId: "exp2", kind: "experience", rank: 2, score: 4, basis: { evidenceRefs: [], methodCredits: ["exact"], recency: 1 } },
        { entryId: "edu1", kind: "education", rank: 1, score: 3, basis: { evidenceRefs: [], methodCredits: [], recency: 1 } },
        { entryId: "proj1", kind: "project", rank: 1, score: 3, basis: { evidenceRefs: [], methodCredits: [], recency: 1 } },
        { entryId: "cert1", kind: "certification", rank: 1, score: 2, basis: { evidenceRefs: [], methodCredits: [], recency: 1 } },
      ],
      generatedAt: "2026-10-28T00:00:00Z",
    } as SelectionRecord;
    expect(computeSelectionIntegrity(content, selection, snapshot)).toBe(true);
  });

  it("selection integrity fails when an entry is neither included nor omitted", () => {
    expect(computeSelectionIntegrity(content, null, snapshot)).toBe(false);
  });

  it("omissions are reasoned only for selection/page_budget reasons", () => {
    expect(computeOmissionsReasoned(content)).toBe(true);
    const bad = {
      ...content,
      omissions: [{ type: "experience", id: "x", reason: "unwritten" }],
    } as GeneratedCVContent;
    expect(computeOmissionsReasoned(bad)).toBe(false);
  });

  it("summary length honors the frozen bound", () => {
    expect(computeSummaryLengthOk(content, settings)).toBe(true);
    const long = { ...content, summary: "word ".repeat(61) } as GeneratedCVContent;
    expect(computeSummaryLengthOk(long, settings)).toBe(false);
  });

  it("page budget compares the final page count to the frozen budget", () => {
    expect(computePageBudgetOk({ passed: true, pages: 2 }, settings)).toBe(true);
    expect(computePageBudgetOk({ passed: true, pages: 3 }, settings)).toBe(false);
    expect(computePageBudgetOk(null, settings)).toBe(false);
  });

  it("extraction gate must have explicitly passed", () => {
    expect(computeExtractionGateOk({ passed: true })).toBe(true);
    expect(computeExtractionGateOk({ passed: false })).toBe(false);
    expect(computeExtractionGateOk(undefined)).toBe(false);
  });

  it("detects output language via the joined document text", () => {
    expect(computeOutputLanguageOk(contentText(content), "en")).toBe(true);
    expect(
      computeOutputLanguageOk(
        "Amélioration des temps de réponse de l'API et gestion des environnements de production.",
        "fr",
      ),
    ).toBe(true);
    expect(computeOutputLanguageOk(contentText(content), "fr")).toBe(false);
  });
});
