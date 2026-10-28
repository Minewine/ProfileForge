import { describe, expect, it } from "vitest";
import { extractPdfPages } from "@/lib/parsing/pdf";
import { normalizeText } from "@/lib/text/normalize";
import { runExtractionGate } from "@/lib/generation/verify";
import { fitCVToBudget } from "@/lib/generation/fit";
import { buildCVPlan, type PinnedSnapshot } from "@/lib/generation/plan";
import { DESIGNED_TOKENS, renderDesignedCV } from "@/lib/generation/render/designed";
import type { GeneratedCVContent, GenerationSettings } from "@/lib/generation/schemas";

// Phase 8 — the designed two-column template: dynamic multi-value rendering
// (no fixed slot counts), same extraction gate as the ATS PDF, deterministic
// bytes, budget-aware through the shared fit loop.

function bullet(id: string, text: string) {
  return { id, text, confidence: null, containmentOk: null };
}

function snapshotFixture(overrides: Partial<PinnedSnapshot> = {}): PinnedSnapshot {
  return {
    id: "p1",
    version: 3,
    language: "en",
    basics: {
      name: "Camille Durand",
      headline: null,
      summary: null,
      location: "Lyon, France",
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
        bullets: [bullet("b1", "Direction de la migration vers une architecture orientée services.")],
      },
      {
        id: "e2",
        company: "Atelier Numérique",
        title: "Développeuse",
        location: null,
        startDate: "2018-04",
        endDate: "2020-12",
        skillsUsed: [],
        bullets: [bullet("b2", "Conception d'API utilisées par 2 millions d'utilisateurs.")],
      },
      {
        id: "e3",
        company: "Beta Corp",
        title: "Junior Engineer",
        location: "Berlin",
        startDate: "2016-01",
        endDate: "2018-01",
        skillsUsed: [],
        bullets: [bullet("b3", "Maintained the build pipeline."), bullet("b3b", "Wrote integration tests for 12 services.")],
      },
    ],
    education: [
      { id: "ed1", institution: "McGill University", degree: "BSc", field: "Computer Science", startDate: "2012-09", endDate: "2016-05" },
      { id: "ed2", institution: "TU Berlin", degree: "MSc", field: "Data Engineering", startDate: null, endDate: null },
    ],
    skills: [],
    languages: [
      { id: "l1", name: "Français", proficiency: "Langue maternelle" },
      { id: "l2", name: "English", proficiency: "Fluent (C1)" },
      { id: "l3", name: "Deutsch", proficiency: null },
    ],
    projects: [],
    certifications: [{ id: "c1", title: "CKA", issuer: "CNCF", issueDate: "2023-04" }],
    ...overrides,
  } as PinnedSnapshot;
}

function contentFixture(overrides: Partial<GeneratedCVContent> = {}): GeneratedCVContent {
  return {
    claimIdVersion: 1,
    summary: "Platform engineer with deep Kubernetes operations experience.",
    summaryProvenance: [],
    experience: [
      {
        id: "e1",
        title: { claimId: "expTitle.e1", text: "Platform Engineer — Kubernetes focus", sourceTitle: "Ingénieure Senior" },
        bullets: [{ claimId: "exp.e1.1", text: "Direction de la migration vers une architecture orientée services.", sourceBulletIds: ["b1"] }],
      },
      {
        id: "e2",
        bullets: [{ claimId: "exp.e2.1", text: "Conception d'API utilisées par 2 millions d'utilisateurs.", sourceBulletIds: ["b2"] }],
      },
      {
        id: "e3",
        bullets: [
          { claimId: "exp.e3.1", text: "Maintained the build pipeline.", sourceBulletIds: ["b3"] },
          { claimId: "exp.e3.2", text: "Wrote integration tests for 12 services.", sourceBulletIds: ["b3b"] },
        ],
      },
    ],
    education: [
      { id: "ed1", claimId: "edu.ed1", text: "BSc · Computer Science · McGill University", sourceIds: ["ed1"] },
      { id: "ed2", claimId: "edu.ed2", text: "MSc · Data Engineering · TU Berlin", sourceIds: ["ed2"] },
    ],
    projects: [],
    certifications: [{ id: "c1", claimId: "cert.c1", text: "CKA · CNCF", sourceIds: ["c1"] }],
    skills: ["Kubernetes", "Go", "Terraform", "Kafka", "PostgreSQL", "Observability", "Incident Response"],
    omissions: [],
    ...overrides,
  };
}

const DESIGNED: GenerationSettings = {
  outputLanguage: "en",
  pageBudget: 2,
  tone: "professional",
  summaryMaxWords: 60,
  templateId: "designed",
};

async function extractedText(bytes: Uint8Array): Promise<string> {
  const pages = await extractPdfPages(new Uint8Array(bytes));
  return pages.map((p) => p.text).join("\n");
}

describe("renderDesignedCV (phase 8)", () => {
  it("renders every multi-value item DYNAMICALLY — N entries, per-entry bullets, K skills, J languages", async () => {
    const snapshot = snapshotFixture();
    const content = contentFixture();
    const { bytes, pageCount } = await renderDesignedCV({ content, snapshot, settings: DESIGNED });
    expect(pageCount).toBeGreaterThanOrEqual(1);
    const text = normalizeText(await extractedText(bytes));

    // 3 experience entries with DIFFERENT bullet counts (1 / 1 / 2) — no fixed slots
    for (const entry of content.experience) {
      for (const b of entry.bullets) expect(text).toContain(normalizeText(b.text));
    }
    // the rewritten title renders (US2 mechanism works in the designed layout)
    expect(text).toContain(normalizeText("Platform Engineer — Kubernetes focus"));
    // all 7 skills — one line each
    for (const skill of content.skills) expect(text).toContain(normalizeText(skill));
    // languages with proficiency; a null proficiency renders the name alone
    expect(text).toContain(normalizeText("Français — Langue maternelle"));
    expect(text).toContain(normalizeText("English — Fluent (C1)"));
    expect(text).toContain(normalizeText("Deutsch"));
    // contact sidebar values + the name
    expect(text).toContain(normalizeText("Camille Durand"));
    expect(text).toContain(normalizeText("camille.durand@example.fr"));
    expect(text).toContain(normalizeText("+33 6 12 34 56 78"));
    // education + certifications
    expect(text).toContain(normalizeText("BSc · Computer Science · McGill University"));
    expect(text).toContain(normalizeText("CKA · CNCF"));
  });

  it("passes the SAME extraction gate as the ATS render (level 1 + level 2)", async () => {
    const snapshot = snapshotFixture();
    const content = contentFixture();
    const { bytes } = await renderDesignedCV({ content, snapshot, settings: DESIGNED });
    const check = await runExtractionGate({ pdfBytes: bytes, content, snapshot, settings: DESIGNED });
    expect(check.passed).toBe(true);
    expect(check.level1.passed).toBe(true);
    expect(check.level2.passed).toBe(true);
  });

  it("localizes headings for FR and DE output (Kurzprofil / Berufserfahrung / Ausbildung / Fähigkeiten / Sprachen / Kontakt)", async () => {
    const snapshot = snapshotFixture();
    const content = contentFixture();
    const de = await renderDesignedCV({
      content,
      snapshot,
      settings: { ...DESIGNED, outputLanguage: "de" },
    });
    const deText = normalizeText(await extractedText(de.bytes));
    for (const heading of ["Kurzprofil", "Berufserfahrung", "Ausbildung", "Fähigkeiten", "Sprachen", "Kontakt", "Zertifikate"]) {
      expect(deText).toContain(normalizeText(heading));
    }

    const fr = await renderDesignedCV({ content, snapshot, settings: { ...DESIGNED, outputLanguage: "fr" } });
    const frText = normalizeText(await extractedText(fr.bytes));
    for (const heading of ["Résumé professionnel", "Expérience professionnelle", "Formation", "Compétences", "Langues"]) {
      expect(frText).toContain(normalizeText(heading));
    }
  });

  it("is deterministic — identical inputs produce byte-identical PDFs", async () => {
    const snapshot = snapshotFixture();
    const content = contentFixture();
    const a = await renderDesignedCV({ content, snapshot, settings: DESIGNED });
    const b = await renderDesignedCV({ content, snapshot, settings: DESIGNED });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("paginates and fits through the shared loop — budget 1 demotes with page_budget omissions, never past the must-include set", async () => {
    const snapshot = snapshotFixture();
    // a heavy content fixture: 3 entries with many long bullets overflows 1 page
    const heavy = contentFixture({
      experience: snapshot.experience.map((e, i) => ({
        id: e.id,
        ...(i === 0
          ? { title: { claimId: `expTitle.${e.id}`, text: "Platform Engineer", sourceTitle: e.title } }
          : {}),
        bullets: Array.from({ length: 14 }, (_, n) => ({
          claimId: `exp.${e.id}.${n + 1}`,
          text: `Bullet ${n + 1} for ${e.company}: livré un composant critique avec des métriques mesurables et une revue par les pairs.`,
          sourceBulletIds: [e.bullets[0]!.id],
        })),
      })),
    });
    const report = {
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
      requirements: [],
      recommendedKeywords: [],
      missingKeywords: [],
      semanticDropped: 0,
    };
    const plan = buildCVPlan({ snapshot, report, now: new Date("2026-01-01T00:00:00Z") });

    const outcome = await fitCVToBudget({
      content: heavy,
      plan,
      snapshot,
      settings: { ...DESIGNED, pageBudget: 1 },
    });
    expect(outcome.pageCount).toBeLessThanOrEqual(1);
    expect(outcome.content.omissions.length).toBeGreaterThan(0);
    expect(outcome.content.omissions.every((o) => o.reason === "page_budget")).toBe(true);

    // the same light content fits budget 2 without any demotion
    const light = await fitCVToBudget({ content: contentFixture(), plan, snapshot, settings: DESIGNED });
    expect(light.pageCount).toBeLessThanOrEqual(2);
    expect(light.content.omissions).toEqual([]);
  });

  it("exposes the design tokens the DOCX renderer shares (navy/sidebar/muted hex)", () => {
    expect(DESIGNED_TOKENS).toEqual({
      navy: "1E3A5F",
      sidebarFill: "E8F0F8",
      body: "000000",
      muted: "666666",
      meta: "888888",
      font: "Calibri",
    });
  });

  it("DOCX: two-column table grid, sidebar shading, Calibri, navy runs, and every dynamic item as its own paragraph", async () => {
    const { renderCVDocx } = await import("@/lib/generation/render/docx");
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");

    const snapshot = snapshotFixture();
    const content = contentFixture();
    const bytes = await renderCVDocx({ content, snapshot, settings: DESIGNED });

    const tmp = path.join(process.env.UPLOADS_DIR ?? "./uploads-test", `designed-${Date.now()}.docx`);
    writeFileSync(tmp, bytes);
    try {
      const xml = execFileSync(
        "python3",
        [
          "-c",
          "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);"
            + "print(z.read('word/document.xml').decode('utf-8'));"
            + "print(z.read('word/styles.xml').decode('utf-8'))",
          tmp,
        ],
        { encoding: "utf8" },
      );

      // the attached template's grid (3663/6803 twips) and sidebar shading
      expect(xml).toContain('<w:gridCol w:w="3663"/>');
      expect(xml).toContain('<w:gridCol w:w="6803"/>');
      expect(xml).toContain(`w:fill="${DESIGNED_TOKENS.sidebarFill}"`);
      expect(xml).toContain('w:fill="E8F0F8"');
      // design: Calibri face (styles.xml default) + navy heading runs + 720-twip margins
      expect(xml).toContain('w:ascii="Calibri"');
      expect(xml).toContain(`<w:color w:val="${DESIGNED_TOKENS.navy}"/>`);
      expect(xml).toContain('w:top="720"');

      // dynamic items — every skill, language (with proficiency), bullet, and the
      // rewritten title appear as text runs; counts come from content, not slots
      // (unescape XML entities first — French apostrophes serialize as &apos;)
      const unescaped = xml
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      for (const skill of content.skills) expect(unescaped).toContain(`• ${skill}`);
      expect(unescaped).toContain("Français — Langue maternelle");
      expect(unescaped).toContain("English — Fluent (C1)");
      expect(unescaped).toContain("Deutsch");
      for (const entry of content.experience) {
        for (const b of entry.bullets) expect(unescaped).toContain(b.text);
      }
      expect(unescaped).toContain("Platform Engineer — Kubernetes focus");
      // the initials photo placeholder, not a fixed image
      expect(unescaped).toContain("[CD]");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("DOCX: the ATS default is unchanged — no table, no shading, when templateId is absent", async () => {
    const { renderCVDocx } = await import("@/lib/generation/render/docx");
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");

    const snapshot = snapshotFixture();
    const content = contentFixture();
    const bytes = await renderCVDocx({
      content,
      snapshot,
      settings: { outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 60 }, // no templateId
    });

    const tmp = path.join(process.env.UPLOADS_DIR ?? "./uploads-test", `ats-${Date.now()}.docx`);
    writeFileSync(tmp, bytes);
    try {
      const xml = execFileSync(
        "python3",
        ["-c", "import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf-8'))", tmp],
        { encoding: "utf8" },
      );
      expect(xml).not.toContain("<w:tbl>"); // single-column flow — no two-column table
      expect(xml).not.toContain("E8F0F8");
      expect(xml).toContain("Professional Summary"); // ATS heading map
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
