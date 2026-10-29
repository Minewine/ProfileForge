import { describe, expect, it } from "vitest";
import { loadSpec, parseSpecSections } from "../../prisma/seed/seed-demo";
import { MIN_JD_CHARS } from "../../src/lib/jobs/schemas";

// DB-free: runs the committed demo fixtures through the seed script's own
// validation (credentials/language guards, section zod schemas, JD length
// minimum) so a bad fixture edit fails CI before anyone runs the seed.
describe("demo seed fixtures", () => {
  it.each(["fr", "en"] as const)("parses the %s fixture through the seed's validation", async (lang) => {
    const { spec, jdText } = await loadSpec(lang);
    expect(jdText.length).toBeGreaterThanOrEqual(MIN_JD_CHARS);

    const sections = parseSpecSections(spec);
    expect(sections.basics.name).toMatch(/[A-Za-zÀ-ÿ]/);
    for (const list of [
      sections.experiences,
      sections.educations,
      sections.skills,
      sections.languages,
      sections.projects,
      sections.certifications,
    ]) {
      expect(list.length).toBeGreaterThan(0);
    }
    const expBullets = sections.experiences.reduce((n, e) => n + e.bullets.create.length, 0);
    const projBullets = sections.projects.reduce((n, p) => n + p.bullets.create.length, 0);
    expect(expBullets).toBeGreaterThan(0);
    expect(projBullets).toBeGreaterThan(0);
  });

  it("keeps the two demo accounts distinct and correctly localized", async () => {
    const [fr, en] = await Promise.all([loadSpec("fr"), loadSpec("en")]);
    expect(fr.spec.email).not.toBe(en.spec.email);
    expect(fr.spec.profile.language).toBe("fr");
    expect(en.spec.profile.language).toBe("en");
    expect(fr.spec.analysis.jdFile).toContain("demo-jd-fr.txt");
    expect(en.spec.analysis.jdFile).toContain("demo-jd-en.txt");
  });
});
