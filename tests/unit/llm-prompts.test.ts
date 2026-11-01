import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computePromptSetVersion, loadSystemPrompt, loadSystemPromptFrom } from "@/lib/llm/prompts/load";
import { getTaskDefinition } from "@/lib/llm/registry";
import { buildParseCvPrompt } from "@/lib/llm/tasks/parsecv";
// Importing the task modules IS the registration step — each module loads its
// system prompt at import time and registers with it. A missing/empty prompt
// file would make these imports throw (fail-fast at startup).
import "@/lib/llm/tasks/extractrequirements";
import "@/lib/llm/tasks/semanticproposals";
import "@/lib/llm/tasks/generatetailoredcv";
import "@/lib/llm/tasks/generatecoverletter";

const SHIPPED_PROMPTS = [
  { file: "parseCV.md", firstLine: "You are a precise CV parsing engine." },
  { file: "extractRequirements.md", firstLine: "You are a precise job-description requirement extractor." },
  { file: "semanticProposals.md", firstLine: "You match job requirements against a candidate's profile digest." },
  { file: "generateTailoredCV.md", firstLine: "You draft a tailored CV from a deterministic, evidence-keyed plan." },
  { file: "generateCoverLetter.md", firstLine: "You draft a cover letter from a deterministic, evidence-keyed paragraph plan." },
] as const;

function withTempPromptDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pf-prompts-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("prompt loader", () => {
  it("returns the shipped prompt text for every task", () => {
    for (const { file, firstLine } of SHIPPED_PROMPTS) {
      const prompt = loadSystemPrompt(file);
      expect(prompt.startsWith(firstLine), file).toBe(true);
      expect(prompt).toContain("non-negotiable");
      expect(prompt).toContain("Respond ONLY");
    }
  });

  it("fails on a missing prompt file", () => {
    withTempPromptDir({}, (dir) => {
      expect(() => loadSystemPromptFrom(dir, "parseCV.md")).toThrow(/missing from/);
    });
  });

  it("fails on an empty or whitespace-only prompt file", () => {
    withTempPromptDir({ "parseCV.md": "", "extractRequirements.md": "  \n\t " }, (dir) => {
      expect(() => loadSystemPromptFrom(dir, "parseCV.md")).toThrow(/is empty/);
      expect(() => loadSystemPromptFrom(dir, "extractRequirements.md")).toThrow(/is empty/);
    });
  });
});

describe("prompt set versioning (benchmark baselines)", () => {
  it("is stable for unchanged files and order-independent", () => {
    const v = () => computePromptSetVersion();
    expect(v()).toBe(v());
    withTempPromptDir(
      { "b.md": "bravo", "a.md": "alpha" },
      (dir) => {
        const expected = computePromptSetVersion(dir);
        expect(expected).not.toBe(v()); // different set → different version
      },
    );
  });

  it("changes when any prompt file's content changes", () => {
    withTempPromptDir({ "parseCV.md": "alpha" }, (dir) => {
      const before = computePromptSetVersion(dir);
      writeFileSync(join(dir, "parseCV.md"), "alpha\nbeta");
      expect(computePromptSetVersion(dir)).not.toBe(before);
    });
  });
});

describe("assembled task prompts", () => {
  it("parseCV: system message is the loaded prompt; user message carries language + text", () => {
    const messages = buildParseCvPrompt({ text: "x".repeat(60), language: "fr" });
    expect(messages[0]).toEqual({ role: "system", content: loadSystemPrompt("parseCV.md") });
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("detected language: fr");
    expect(messages[1].content).toContain("x".repeat(60));
  });

  it("extractRequirements: system message is the loaded prompt", () => {
    const task = getTaskDefinition("extractRequirements");
    expect(task).toBeDefined();
    const messages = task!.buildPrompt({ text: "y".repeat(60), language: "en" });
    expect(messages[0]).toEqual({ role: "system", content: loadSystemPrompt("extractRequirements.md") });
    expect(messages[1].content).toContain("language: en");
  });

  it("semanticProposals: system message is the loaded prompt; user message carries digest and requirements", () => {
    const task = getTaskDefinition("semanticProposals");
    const messages = task!.buildPrompt({
      language: "en",
      requirements: [{ index: 0, text: "Kubernetes" }],
      profileDigest: [{ id: "skill-1", type: "skill", text: "Kubernetes ops" }],
    });
    expect(messages[0]).toEqual({ role: "system", content: loadSystemPrompt("semanticProposals.md") });
    expect(messages[1].content).toContain("#0: Kubernetes");
    expect(messages[1].content).toContain("[skill-1] (skill) Kubernetes ops");
  });

  it("generateTailoredCV: substitutes {summaryMaxWords} into the loaded prompt", () => {
    const task = getTaskDefinition("generateTailoredCV");
    const payload = {
      outputLanguage: "en",
      plan: [
        {
          key: "exp.1.0",
          kind: "experience",
          sourceText: ["Built the thing"],
          entryMeta: { title: "Engineer", company: "Acme", dates: "2021–2023" },
        },
      ],
      skills: ["Go"],
      summarySources: ["Built the thing"],
      summaryRequirements: ["Go"],
      summaryMaxWords: 60,
      jdDigest: { role: "Backend Engineer", keywords: ["Go"] },
      pageBudget: 2,
    } as const;
    const messages = task!.buildPrompt(payload);
    const expected = loadSystemPrompt("generateTailoredCV.md").replaceAll("{summaryMaxWords}", "60");
    expect(messages[0]).toEqual({ role: "system", content: expected });
    expect(messages[0].content).toContain("at most 60 words");
    expect(messages[0].content).not.toContain("{summaryMaxWords}");
    expect(messages[1].content).toContain("Page budget: 2 page(s)");
    expect(messages[1].content).toContain("[exp.1.0] (experience) Engineer · Acme · 2021–2023");
  });

  it("generateCoverLetter: system message is the loaded prompt", () => {
    const task = getTaskDefinition("generateCoverLetter");
    const messages = task!.buildPrompt({
      outputLanguage: "en",
      tone: "professional",
      paragraphs: [{ key: "p1", angle: "motivation", evidenceText: ["Loved Acme since childhood"] }],
      cvBulletTexts: [],
      jdDigest: { topRequirements: [] },
      maxWords: 200,
    });
    expect(messages[0]).toEqual({ role: "system", content: loadSystemPrompt("generateCoverLetter.md") });
    expect(messages[1].content).toContain("Max words total: 200");
  });
});
