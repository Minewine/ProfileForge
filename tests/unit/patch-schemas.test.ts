import { describe, expect, it } from "vitest";
import { PatchSchemas } from "@/lib/profile/sectionSchemas";
import type { SectionName } from "@/lib/validation/schemas";

/**
 * Spec 007 — strict partial patch semantics (research D1 / contracts/api.md):
 * a key absent from the request body is absent from the parsed patch; schema
 * defaults must never be fabricated into autosave PATCHes.
 */
const SECTIONS = ["experience", "education", "skills", "languages", "projects", "certifications"] as const;

const PROBE: Record<SectionName, Record<string, unknown>> = {
  experience: { company: "Acme" },
  education: { institution: "EPITA" },
  skills: { name: "Go" },
  languages: { name: "Français" },
  projects: { name: "ProfileForge" },
  certifications: { title: "AWS SA" },
};

const NULLISH_FIELD: Record<SectionName, string> = {
  experience: "startDate",
  education: "grade",
  skills: "category",
  languages: "proficiency",
  projects: "link",
  certifications: "issuer",
};

describe("strict partial patch schemas (spec 007)", () => {
  it.each(SECTIONS)("%s: an empty patch parses to an empty object (no defaults fabricated)", (section) => {
    expect(PatchSchemas[section].parse({})).toEqual({});
  });

  it.each(SECTIONS)("%s: only the sent key is applied", (section) => {
    expect(PatchSchemas[section].parse(PROBE[section])).toEqual(PROBE[section]);
  });

  it.each(SECTIONS)("%s: null is accepted for a nullish optional and clears it", (section) => {
    const field = NULLISH_FIELD[section];
    expect(PatchSchemas[section].parse({ [field]: null })).toEqual({ [field]: null });
  });

  it.each(SECTIONS)("%s: an explicit provenance value passes through present", (section) => {
    expect(PatchSchemas[section].parse({ provenance: "user_confirmed" })).toEqual({
      provenance: "user_confirmed",
    });
  });

  it("empty string is invalid for date fields (the UI must send null to clear)", () => {
    expect(PatchSchemas.experience.safeParse({ startDate: "" }).success).toBe(false);
    expect(PatchSchemas.experience.safeParse({ endDate: "" }).success).toBe(false);
    expect(PatchSchemas.certifications.safeParse({ issueDate: "" }).success).toBe(false);
  });

  it("array fields are replaced as sent, not merged with defaults", () => {
    expect(PatchSchemas.experience.parse({ skillsUsed: ["Go"] })).toEqual({ skillsUsed: ["Go"] });
    expect(PatchSchemas.skills.parse({ aliases: [] })).toEqual({ aliases: [] });
  });

  it("bullet patches carry no fabricated fields (order stays absent so the server can use the index)", () => {
    expect(PatchSchemas.experience.parse({ bullets: [{ text: "Did things" }] })).toEqual({
      bullets: [{ text: "Did things" }],
    });
    expect(PatchSchemas.experience.parse({ bullets: [{ id: "b1", text: "Reworded" }] })).toEqual({
      bullets: [{ id: "b1", text: "Reworded" }],
    });
  });

  it("create schemas still enforce required fields and defaults (unchanged contract)", async () => {
    const { CreateSchemas } = await import("@/lib/profile/sectionSchemas");
    const created = CreateSchemas.experience.parse({ company: "Acme", title: "Eng" });
    expect(created.provenance).toBe("user_entered");
    expect(created.skillsUsed).toEqual([]);
    expect(created.bullets).toEqual([]);
    expect(created.order).toBe(0);
  });
});
