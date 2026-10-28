import { describe, expect, it } from "vitest";
import { extractPdfPages } from "@/lib/parsing/pdf";
import { normalizeText } from "@/lib/text/normalize";
import {
  PAGE_LAYOUT,
  SECTION_HEADINGS,
  SingleColumnDoc,
  formatDateRange,
  sanitizeToAscii,
  sanitizeWinAnsi,
  sectionHeading,
} from "@/lib/generation/render/template";
import { activeSections, renderCV } from "@/lib/generation/render/cv";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings } from "@/lib/generation/schemas";

// T027 — rendered-template invariants (contracts/generation-pipeline.md
// §Rendered template invariants): single column, fixed bilingual heading map,
// YYYY-MM/"present" dates, WinAnsi sanitizer with diacritics preserved,
// optional sections never empty, no text outside body content.

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
        endDate: null, // null = present
        skillsUsed: [],
        bullets: [
          {
            id: "b1",
            text: "Direction de la migration vers une architecture orientée services.",
            confidence: null,
            containmentOk: null,
          },
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
          {
            id: "b2",
            text: "Conception d'un pipeline de données traitant 1,5 million d'événements par jour.",
            confidence: null,
            containmentOk: null,
          },
        ],
      },
    ],
    education: [
      {
        id: "ed1",
        institution: "Université Claude Bernard Lyon 1",
        degree: "Master",
        field: "Informatique",
        startDate: "2012-09",
        endDate: "2014-06",
      },
    ],
    skills: [{ id: "s1", name: "Kubernetes" }],
    languages: [{ id: "l1", name: "Français" }],
    projects: [
      {
        id: "pr1",
        name: "ATS Checker",
        description: null,
        startDate: null,
        endDate: null,
        bullets: [
          {
            id: "pb1",
            text: "Built an ATS compliance checker used by 400 users.",
            confidence: null,
            containmentOk: null,
          },
        ],
      },
    ],
    certifications: [{ id: "c1", title: "CKA", issuer: "CNCF", issueDate: "2023-04" }],
    ...overrides,
  } as PinnedSnapshot;
}

function contentFixture(overrides: Partial<GeneratedCVContent> = {}): GeneratedCVContent {
  return {
    claimIdVersion: 1,
    summary: "Ingénieure logicielle senior avec 9 ans d'expérience en systèmes distribués.",
    summaryProvenance: [],
    experience: [
      {
        id: "e1",
        bullets: [{ claimId: "exp.e1.1", text: "Réduction du temps de déploiement de 60 %.", sourceBulletIds: ["b1"] }],
      },
      {
        id: "e2",
        bullets: [{ claimId: "exp.e2.1", text: "Mise en place de tests de charge automatisés.", sourceBulletIds: ["b2"] }],
      },
    ],
    education: [
      { id: "ed1", claimId: "edu.ed1", text: "Master · Informatique · Université Claude Bernard Lyon 1", sourceIds: ["ed1"] },
    ],
    projects: [
      {
        id: "pr1",
        bullets: [
          { claimId: "proj.pr1.1", text: "Built an ATS compliance checker used by 400 users.", sourceBulletIds: ["pb1"] },
        ],
      },
    ],
    certifications: [{ id: "c1", claimId: "cert.c1", text: "CKA · CNCF", sourceIds: ["c1"] }],
    skills: ["Kubernetes"],
    omissions: [],
    ...overrides,
  };
}

const SETTINGS: GenerationSettings = { outputLanguage: "fr", pageBudget: 2, tone: "professional", summaryMaxWords: 60 };

async function extractLines(bytes: Uint8Array): Promise<string[]> {
  const pages = await extractPdfPages(bytes);
  return pages
    .map((p) => p.text)
    .join("\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// --- Bilingual heading map (exact, fixed) ---

describe("SECTION_HEADINGS", () => {
  it("maps every section exactly in EN", () => {
    expect(SECTION_HEADINGS.en).toEqual({
      summary: "Professional Summary",
      experience: "Experience",
      education: "Education",
      skills: "Skills",
      projects: "Projects",
      certifications: "Certifications",
      languages: "Languages",
    });
  });

  it("maps every section exactly in FR", () => {
    expect(SECTION_HEADINGS.fr).toEqual({
      summary: "Résumé professionnel",
      experience: "Expérience professionnelle",
      education: "Formation",
      skills: "Compétences",
      projects: "Projets",
      certifications: "Certifications",
      languages: "Langues",
    });
  });

  it("maps every section exactly in DE (phase 8: FR/EN/DE)", () => {
    expect(SECTION_HEADINGS.de).toEqual({
      summary: "Kurzprofil",
      experience: "Berufserfahrung",
      education: "Ausbildung",
      skills: "Fähigkeiten",
      projects: "Projekte",
      certifications: "Zertifikate",
      languages: "Sprachen",
    });
  });

  it("sectionHeading resolves per language", () => {
    expect(sectionHeading("en", "summary")).toBe("Professional Summary");
    expect(sectionHeading("fr", "experience")).toBe("Expérience professionnelle");
    expect(sectionHeading("fr", "education")).toBe("Formation");
    expect(sectionHeading("fr", "skills")).toBe("Compétences");
    expect(sectionHeading("de", "summary")).toBe("Kurzprofil");
    expect(sectionHeading("de", "experience")).toBe("Berufserfahrung");
  });
});

// --- Dates (YYYY-MM / present) ---

describe("date formatting", () => {
  it("renders ranges as YYYY-MM with present for ongoing entries", () => {
    expect(formatDateRange("2021-01", null)).toBe("2021-01 - present");
    expect(formatDateRange("2021-01", "present")).toBe("2021-01 - present");
    expect(formatDateRange("2018-04", "2020-12")).toBe("2018-04 - 2020-12");
    expect(formatDateRange(null, "2024-06")).toBe("2024-06");
    expect(formatDateRange(null, null)).toBe("");
  });
});

// --- WinAnsi sanitizer (diacritics preserved, exotic characters folded) ---

describe("sanitizeWinAnsi", () => {
  it("passes Latin-1 diacritics through untouched", () => {
    expect(sanitizeWinAnsi("é è ç à ù â ê î ô û")).toBe("é è ç à ù â ê î ô û");
    expect(sanitizeWinAnsi("É È Ç À")).toBe("É È Ç À");
  });

  it("maps typographic characters outside the safe set to ASCII equivalents", () => {
    expect(sanitizeWinAnsi("café — ‘vrai’ – naïve")).toBe("café - 'vrai' - naïve");
    expect(sanitizeWinAnsi("dit “vrai”")).toBe('dit "vrai"');
    expect(sanitizeWinAnsi("attente…")).toBe("attente...");
    expect(sanitizeWinAnsi("100 €")).toBe("100 EUR");
    expect(sanitizeWinAnsi("a b c")).toBe("a b c"); // non-breaking / fine spaces
  });

  it("folds characters with no WinAnsi encoding to a safe base or drops them", () => {
    expect(sanitizeWinAnsi("ế toit")).toBe("e toit"); // decomposable Latin base kept
    expect(sanitizeWinAnsi("日本語")).toBe(""); // unencodable, no Latin base
  });

  it("sanitizeToAscii is the aggressive fallback pass (used by gate retries)", () => {
    expect(sanitizeToAscii("Résumé professionnel — café")).toBe("Resume professionnel - cafe");
    expect(sanitizeToAscii("é è ç à")).toBe("e e c a");
  });
});

// --- Rendered output (single column, section order, no stray text) ---

describe("renderCV", () => {
  it("renders name and contact as body text at the top of page 1", async () => {
    const { bytes } = await renderCV({ content: contentFixture(), snapshot: snapshotFixture(), settings: SETTINGS });
    const lines = await extractLines(bytes);
    expect(lines[0]).toBe("Camille Durand");
    expect(lines[1]).toContain("camille.durand@example.fr");
    expect(lines[1]).toContain("+33 6 12 34 56 78");
    expect(lines[1]).toContain("https://camille.example.dev");
  });

  it("renders sections in the fixed order with the bilingual headings and preserves diacritics", async () => {
    const { bytes } = await renderCV({ content: contentFixture(), snapshot: snapshotFixture(), settings: SETTINGS });
    const text = (await extractLines(bytes)).join("\n");

    // every section with content renders its heading, in order
    const headings = [
      "Résumé professionnel",
      "Expérience professionnelle",
      "Formation",
      "Compétences",
      "Projets",
      "Certifications",
    ];
    let cursor = -1;
    for (const heading of headings) {
      const at = text.indexOf(heading);
      expect(at, `heading "${heading}" must render`).toBeGreaterThan(-1);
      expect(at, `heading "${heading}" out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }

    // diacritics pass through the real render (not folded away)
    expect(text).toContain("Résumé professionnel");
    expect(text).toContain("Ingénieure Senior");
    expect(text).toContain("Société Générale");

    // dates as YYYY-MM / present
    expect(text).toContain("2021-01 - present");
    expect(text).toContain("2018-04 - 2020-12");
    expect(text).toContain("2023-04"); // certification issue date
  });

  it("renders the EN heading map for EN output", async () => {
    const { bytes } = await renderCV({
      content: contentFixture(),
      snapshot: snapshotFixture(),
      settings: { ...SETTINGS, outputLanguage: "en" },
    });
    const text = (await extractLines(bytes)).join("\n");
    for (const heading of ["Professional Summary", "Experience", "Education", "Skills", "Projects", "Certifications"]) {
      expect(text).toContain(heading);
    }
    expect(text).not.toContain("Résumé professionnel");
  });

  it("never renders empty optional sections", async () => {
    const snapshot = snapshotFixture({ projects: [], certifications: [] });
    const content = contentFixture({ projects: [], certifications: [] });
    expect(activeSections(content)).not.toContain("projects");
    expect(activeSections(content)).not.toContain("certifications");

    const { bytes } = await renderCV({ content, snapshot, settings: SETTINGS });
    const text = (await extractLines(bytes)).join("\n");
    expect(text).not.toContain("Projets");
    expect(text).not.toContain("Certifications");
    expect(text).not.toContain("Langues"); // a CV never carries language-section content
  });

  it("sanitizes WinAnsi-external characters in rendered content while keeping the text extractable", async () => {
    const content = contentFixture({
      summary: "Réduction du temps de déploiement — “60 %” … extrême",
      skills: [],
    });
    const { bytes } = await renderCV({ content, snapshot: snapshotFixture(), settings: SETTINGS });
    const text = (await extractLines(bytes)).join("\n");
    expect(text).toContain('Réduction du temps de déploiement - "60 %" ... extrême');
    expect(text).not.toContain("—");
    expect(text).not.toContain("“");
  });

  it("draws no text outside the body content (every extracted line comes from the content)", async () => {
    const content = contentFixture();
    const { bytes } = await renderCV({ content, snapshot: snapshotFixture(), settings: SETTINGS });
    const lines = await extractLines(bytes);

    const expected = normalizeText(
      [
        "Camille Durand",
        "camille.durand@example.fr · +33 6 12 34 56 78 · https://camille.example.dev",
        ...(["summary", "experience", "education", "skills", "projects", "certifications"] as const).map((k) =>
          sectionHeading("fr", k),
        ),
        content.summary,
        "Ingénieure Senior — Société Générale",
        "2021-01 - present",
        "- Réduction du temps de déploiement de 60 %.",
        "Développeuse — Atelier Numérique",
        "2018-04 - 2020-12",
        "- Mise en place de tests de charge automatisés.",
        "Master · Informatique · Université Claude Bernard Lyon 1 (2012-09 - 2014-06)",
        "Kubernetes",
        "ATS Checker",
        "- Built an ATS compliance checker used by 400 users.",
        "CKA · CNCF (2023-04)",
      ].join("\n"),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const n = normalizeText(line);
      if (n) expect(expected.includes(n), `line outside body content: "${line}"`).toBe(true);
    }
  });

  it("keeps all content in the single column and repeats nothing across pages", async () => {
    // enough bullets to force a second page; name/headings must not repeat as a header
    const bullets = Array.from({ length: 60 }, (_, i) => ({
      claimId: `exp.e1.${i + 1}`,
      text: `Ligne de réalisations numéro ${i + 1} avec des résultats mesurables et vérifiables.`,
      sourceBulletIds: ["b1"],
    }));
    const content = contentFixture({
      experience: [{ id: "e1", bullets }],
      projects: [],
      certifications: [],
      education: [],
      skills: [],
    });
    const { bytes, pageCount } = await renderCV({
      content,
      snapshot: snapshotFixture(),
      settings: { ...SETTINGS, pageBudget: 3 },
    });
    expect(pageCount).toBeGreaterThan(1);

    const pages = await extractPdfPages(bytes);
    expect(pages).toHaveLength(pageCount);
    expect(pages[1].text).not.toContain("Camille Durand"); // no header repetition
    expect(pages[1].text).not.toContain("Résumé professionnel"); // no repeated boilerplate
  });
});

// --- Primitives ---

describe("SingleColumnDoc", () => {
  it("exposes a single-column layout and wraps long text to several lines", async () => {
    const doc = await SingleColumnDoc.create();
    doc.addBodyParagraph(`mot ${"very ".repeat(200)}long`);
    doc.addSectionHeading(sectionHeading("fr", "experience"));
    const bytes = await doc.toBytes();

    expect(PAGE_LAYOUT.columnWidth).toBe(PAGE_LAYOUT.pageWidth - 2 * PAGE_LAYOUT.margin);
    const lines = await extractLines(bytes);
    expect(lines.length).toBeGreaterThan(3); // wrapped across several lines
    expect(doc.pageCount).toBe(1);
  });

  it("starts a fresh page instead of overflowing the bottom margin", async () => {
    const doc = await SingleColumnDoc.create();
    for (let i = 0; i < 120; i++) {
      doc.addBodyParagraph(`Paragraphe ${i} avec du texte suffisamment long pour occuper une ligne complète.`);
    }
    expect(doc.pageCount).toBeGreaterThan(1);
    expect((await doc.toBytes()).byteLength).toBeGreaterThan(0);
  });
});
