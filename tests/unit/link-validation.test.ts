import { describe, expect, it } from "vitest";
import { prepareDraft } from "@/lib/profile/prepareDraft";
import { BasicsSchema, normalizeLink, ProfileDraftSchema, ProjectPatchSchema } from "@/lib/validation/schemas";

// Regression (STATUS.md bug 2, fixed 2026-10-28): links imported from a parsed
// CV arrived mangled — "www.linkedin.com:in/coughlan" and
// "www.rametric.com:www.rametric.com" were stored verbatim. Root cause: zod's
// `.url()` accepts scheme-only garbage (new URL() parses it with the garbage
// as the scheme) while rejecting legitimate scheme-less links, and the parse
// draft's project link field was a loose string. Links are now normalized
// (scheme-less → https://) and non-recoverable values are dropped, never
// stored and never fatal to a parse or a save.

describe("normalizeLink", () => {
  it("normalizes scheme-less links to https://", () => {
    expect(normalizeLink("www.linkedin.com/in/coughlan")).toBe("https://www.linkedin.com/in/coughlan");
    expect(normalizeLink(" rametric.com ")).toBe("https://rametric.com");
  });

  it("keeps http(s) links (and their ports/paths) verbatim", () => {
    expect(normalizeLink("https://github.com/Minewine/docsumm/")).toBe("https://github.com/Minewine/docsumm/");
    expect(normalizeLink("http://example.com:8080/x")).toBe("http://example.com:8080/x");
  });

  it("drops the wild-caught garbage and other non-http(s) values", () => {
    expect(normalizeLink("www.linkedin.com.in.coughlan:www.linkedin.com/in/coughlan")).toBeNull();
    expect(normalizeLink("www.rametric.com:www.rametric.com")).toBeNull();
    expect(normalizeLink("ftp://example.com")).toBeNull();
    expect(normalizeLink("not a url at all")).toBeNull();
  });

  it("maps non-string/blank input to null", () => {
    expect(normalizeLink(null)).toBeNull();
    expect(normalizeLink(42)).toBeNull();
    expect(normalizeLink("   ")).toBeNull();
  });
});

describe("BasicsSchema.links", () => {
  it("keeps valid links, normalizes scheme-less ones, drops garbage — never fails", () => {
    const parsed = BasicsSchema.parse({
      name: "M",
      links: [
        "https://www.linkedin.com/in/coughlan",
        "www.rametric.com",
        "www.rametric.com:www.rametric.com", // the wild-caught duplicate
      ],
    });
    expect(parsed.links).toEqual(["https://www.linkedin.com/in/coughlan", "https://www.rametric.com"]);
  });

  it("still enforces the 10-link cap on the input array", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `https://x${i}.com`);
    expect(BasicsSchema.safeParse({ name: "M", links: eleven }).success).toBe(false);
  });
});

describe("ProjectPatchSchema.link", () => {
  it("accepts scheme-less links by normalizing them", () => {
    expect(ProjectPatchSchema.parse({ link: "github.com/Minewine/docsumm" })).toEqual({
      link: "https://github.com/Minewine/docsumm",
    });
  });

  it("rejects garbage with a validation error (strict singular field)", () => {
    expect(ProjectPatchSchema.safeParse({ link: "www.rametric.com:www.rametric.com" }).success).toBe(false);
    expect(ProjectPatchSchema.safeParse({ link: "not a url" }).success).toBe(false);
  });
});

describe("prepareDraft project-link normalization", () => {
  const draft = (link: string | null) =>
    ProfileDraftSchema.parse({
      basics: { name: "M" },
      projects: [{ name: "Docsumm", ...(link !== null ? { link } : {}) }],
    });

  it("normalizes the loose parse-task link field before import", () => {
    const prepared = prepareDraft(draft("www.github.com/docsumm"), "doc-1", "en", "source text");
    expect(prepared.prepared.projects[0]!.link).toBe("https://www.github.com/docsumm");
  });

  it("drops garbage links instead of importing them", () => {
    const prepared = prepareDraft(draft("www.rametric.com:www.rametric.com"), "doc-1", "en", "source text");
    expect(prepared.prepared.projects[0]!.link).toBeNull();
  });
});
