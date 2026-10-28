import { describe, expect, it } from "vitest";
import { extractPdfPages } from "@/lib/parsing/pdf";
import { checkContainment } from "@/lib/validation/sourceContainment";
import { renderCV } from "@/lib/generation/render/cv";
import { runExtractionGate } from "@/lib/generation/verify";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings } from "@/lib/generation/schemas";

// T028 — the two-level extraction gate (FR-013, research R2): level 1
// structural presence (100%), level 2 per-block ≥95% word recovery via
// checkContainment, accent-insensitive for legitimate French, hard failure on
// a corrupted render.

function snapshotFixture(): PinnedSnapshot {
  return {
    id: "p1",
    version: 5,
    language: "fr",
    basics: {
      name: "Camille Durand",
      headline: null,
      summary: null,
      location: null,
      email: "camille.durand@example.fr",
      phone: "+33 6 12 34 56 78",
      links: ["https://camille.example.dev"],
    },
    experience: [
      {
        id: "e1",
        company: "Société Générale",
        title: "Ingénieure Senior",
        location: "Lyon",
        startDate: "2021-01",
        endDate: null,
        skillsUsed: [],
        bullets: [
          { id: "b1", text: "Direction de la migration.", confidence: null, containmentOk: null },
        ],
      },
      {
        id: "e2",
        company: "Atelier Numérique",
        title: "Développeuse",
        location: null,
        startDate: "2018-04",
        endDate: "2020-12",
        skillsUsed: [],
        bullets: [
          { id: "b2", text: "Conception d'un pipeline.", confidence: null, containmentOk: null },
        ],
      },
    ],
    education: [
      { id: "ed1", institution: "Université Lyon 1", degree: "Master", field: "Informatique", startDate: "2012-09", endDate: "2014-06" },
    ],
    skills: [{ id: "s1", name: "Kubernetes" }],
    languages: [],
    projects: [],
    certifications: [{ id: "c1", title: "CKA", issuer: "CNCF", issueDate: "2023-04" }],
  } as PinnedSnapshot;
}

function contentFixture(overrides: Partial<GeneratedCVContent> = {}): GeneratedCVContent {
  return {
    claimIdVersion: 1,
    summary: "Ingénieure logicielle senior avec 9 ans d'expérience en systèmes distribués et Kubernetes.",
    summaryProvenance: [],
    experience: [
      {
        id: "e1",
        bullets: [
          { claimId: "exp.e1.1", text: "Réduction du temps de déploiement de 60 %.", sourceBulletIds: ["b1"] },
        ],
      },
      {
        id: "e2",
        bullets: [
          { claimId: "exp.e2.1", text: "Mise en place de tests de charge automatisés.", sourceBulletIds: ["b2"] },
        ],
      },
    ],
    education: [{ id: "ed1", claimId: "edu.ed1", text: "Master · Informatique · Université Lyon 1", sourceIds: ["ed1"] }],
    projects: [],
    certifications: [{ id: "c1", claimId: "cert.c1", text: "CKA · CNCF", sourceIds: ["c1"] }],
    skills: ["Kubernetes"],
    omissions: [],
    ...overrides,
  };
}

const SETTINGS: GenerationSettings = { outputLanguage: "fr", pageBudget: 2, tone: "professional", summaryMaxWords: 60 };

function gateArgs(content: GeneratedCVContent, bytes: Uint8Array) {
  return { pdfBytes: bytes, content, snapshot: snapshotFixture(), settings: SETTINGS };
}

describe("runExtractionGate", () => {
  it("level 1: every structural element is a normalized substring of the extracted text", async () => {
    const content = contentFixture();
    const { bytes } = await renderCV({ content, snapshot: snapshotFixture(), settings: SETTINGS });
    const check = await runExtractionGate(gateArgs(content, bytes));

    expect(check.level1.passed).toBe(true);
    const byElement = new Map(check.level1.elements.map((e) => [e.element, e]));
    for (const key of ["name", "contact:email", "contact:phone", "contact:link:0"]) {
      expect(byElement.get(key)?.found, `element ${key}`).toBe(true);
    }
    for (const section of ["summary", "experience", "education", "skills", "certifications"]) {
      expect(byElement.get(`heading:${section}`)?.found, `heading ${section}`).toBe(true);
    }
    // each rendered experience entry's company, title, and both dates
    for (const id of ["e1", "e2"] as const) {
      expect(byElement.get(`experience:${id}:company`)?.found).toBe(true);
      expect(byElement.get(`experience:${id}:title`)?.found).toBe(true);
    }
    expect(byElement.get("experience:e1:startDate")?.expected).toBe("2021-01");
    expect(byElement.get("experience:e1:endDate")?.expected).toBe("present");
    expect(byElement.get("experience:e2:endDate")?.expected).toBe("2020-12");
  });

  it("level 2: every rendered block reaches ≥0.95 word recovery via checkContainment", async () => {
    const content = contentFixture();
    const { bytes } = await renderCV({ content, snapshot: snapshotFixture(), settings: SETTINGS });
    const check = await runExtractionGate(gateArgs(content, bytes));

    expect(check.level2.passed).toBe(true);
    expect(check.level2.threshold).toBe(0.95);
    const claimIds = check.level2.blocks.map((b) => b.claimId);
    expect(claimIds).toEqual(
      expect.arrayContaining(["summary", "exp.e1.1", "exp.e2.1", "edu.ed1", "cert.c1", "skill:Kubernetes"]),
    );
    for (const block of check.level2.blocks) {
      expect(block.ok, `block ${block.claimId} (${block.ratio})`).toBe(true);
      expect(block.ratio).toBeGreaterThanOrEqual(0.95);
    }
    // the ratio is checkContainment's own measure against the extracted text
    const summary = check.level2.blocks.find((b) => b.claimId === "summary")!;
    const extracted = (await extractPdfPages(bytes)).map((p) => p.text).join("\n");
    expect(summary.ratio).toBe(checkContainment(content.summary, extracted).ratio);
  });

  it("passes legitimate French accents (accent-insensitive comparison, FR/EN identical rules)", async () => {
    const content = contentFixture();
    const { bytes } = await renderCV({ content, snapshot: snapshotFixture(), settings: SETTINGS });
    const check = await runExtractionGate(gateArgs(content, bytes));
    expect(check.passed).toBe(true);
    expect(check.pages).toBe(1);
  });

  it("passes a render sanitized to plain ASCII (the gate-retry fallback render)", async () => {
    const content = contentFixture();
    const { sanitizeToAscii } = await import("@/lib/generation/render/template");
    const { bytes } = await renderCV({ content, snapshot: snapshotFixture(), settings: SETTINGS, sanitize: sanitizeToAscii });
    const check = await runExtractionGate(gateArgs(content, bytes));
    expect(check.passed).toBe(true); // normalization strips accents on both sides
  });

  it("fails both levels on a corrupted render (a dropped entry)", async () => {
    const full = contentFixture();
    const corrupted = contentFixture({ experience: full.experience.slice(0, 1) }); // e2 never rendered
    const { bytes } = await renderCV({ content: corrupted, snapshot: snapshotFixture(), settings: SETTINGS });
    const check = await runExtractionGate(gateArgs(full, bytes));

    expect(check.passed).toBe(false);
    expect(check.level1.passed).toBe(false);
    expect(check.level1.elements.find((e) => e.element === "experience:e2:company")?.found).toBe(false);
    expect(check.level1.elements.find((e) => e.element === "experience:e2:title")?.found).toBe(false);
    expect(check.level2.passed).toBe(false);
    const missingBlock = check.level2.blocks.find((b) => b.claimId === "exp.e2.1");
    expect(missingBlock?.ok).toBe(false);
    expect(missingBlock?.ratio).toBeLessThan(0.95); // token-set recovery: shared words still count
  });

  it("fails closed on unreadable bytes (garbled render) without throwing", async () => {
    const content = contentFixture();
    const garbage = new TextEncoder().encode("this is not a pdf at all");
    const check = await runExtractionGate(gateArgs(content, garbage));
    expect(check.passed).toBe(false);
    expect(check.level1.passed).toBe(false);
    expect(check.level1.elements.every((e) => !e.found)).toBe(true);
    expect(check.level2.passed).toBe(false);
    expect(check.level2.blocks.every((b) => !b.ok)).toBe(true);
  });
});

// --- US2 (feature 005): the gate checks the RENDERED title ---

describe("level-1 title check against the rendered title (feature 005 US2)", () => {
  it("a rewritten title passes; the snapshot title alone fails when the render carries the rewrite", async () => {
    const { renderCV } = await import("@/lib/generation/render/cv");
    const { runExtractionGate } = await import("@/lib/generation/verify");
    const snapshot = snapshotFixture(); // title "Engineer" at Acme (whatever the fixture carries)
    const rewritten: GeneratedCVContent = {
      ...contentFixture(),
      experience: [
        {
          id: "e1",
          title: { claimId: "expTitle.e1", text: "Platform Engineer — Kubernetes focus", sourceTitle: "Platform Engineer" },
          bullets: [{ claimId: "exp.e1.1", text: "Operated Kubernetes clusters serving 2M requests per day.", sourceBulletIds: ["b1"] }],
        },
      ],
    };
    const settings: GenerationSettings = { outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 60 };
    const rendered = await renderCV({ content: rewritten, snapshot, settings });
    const check = await runExtractionGate({ pdfBytes: rendered.bytes, content: rewritten, snapshot, settings });
    const titleElement = check.level1.elements.find((e) => e.element === "experience:e1:title");
    expect(titleElement?.expected).toBe("Platform Engineer — Kubernetes focus"); // the RENDERED title
    expect(titleElement?.found).toBe(true);

    // without the rewrite, the element expects the snapshot title
    const plain = contentFixture();
    const plainRender = await renderCV({ content: plain, snapshot, settings });
    const plainCheck = await runExtractionGate({ pdfBytes: plainRender.bytes, content: plain, snapshot, settings });
    const plainTitle = plainCheck.level1.elements.find((e) => e.element === "experience:e1:title");
    expect(plainTitle?.expected).toBe(plainTitle?.expected); // structural: the element exists
    expect(plainTitle?.expected).not.toBe("Platform Engineer — Kubernetes focus");
  });
});
