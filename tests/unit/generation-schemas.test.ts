import { describe, expect, it } from "vitest";
import {
  ArtifactMetaSchema,
  ClaimFingerprintSchema,
  CoverLetterContentSchema,
  GeneratedCVContentSchema,
  GenerationSettingsInputSchema,
  GenerationSettingsSchema,
  OmissionSchema,
  SelectionRecordSchema,
  ValidationReportSchema,
  certificationClaimId,
  claimFingerprint,
  educationClaimId,
  experienceClaimId,
  letterClaimId,
  parseClaimId,
  projectClaimId,
  resolveGenerationSettings,
  summaryClaimId,
  titleClaimId,
} from "@/lib/generation/schemas";

const validSettings = {
  outputLanguage: "en" as const,
  pageBudget: 2,
  tone: "professional" as const,
};

describe("GenerationSettings", () => {
  it("accepts pageBudget bounds 1..3 and rejects outside", () => {
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, pageBudget: 1 }).success).toBe(true);
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, pageBudget: 3 }).success).toBe(true);
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, pageBudget: 0 }).success).toBe(false);
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, pageBudget: 4 }).success).toBe(false);
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, pageBudget: 2.5 }).success).toBe(false);
  });

  it("rejects notes over 2000 chars, accepts 2000", () => {
    expect(
      GenerationSettingsSchema.safeParse({ ...validSettings, notes: "x".repeat(2001) }).success,
    ).toBe(false);
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, notes: "x".repeat(2000) }).success).toBe(
      true,
    );
  });

  it("input schema bounds partial user payloads", () => {
    expect(GenerationSettingsInputSchema.safeParse({ pageBudget: 0 }).success).toBe(false);
    expect(GenerationSettingsInputSchema.safeParse({ pageBudget: 3 }).success).toBe(true);
    expect(GenerationSettingsInputSchema.safeParse({ tone: "chipper" }).success).toBe(false);
    expect(GenerationSettingsInputSchema.safeParse({ outputLanguage: "de" }).success).toBe(true); // feature 005 phase 8: FR/EN/DE
    expect(GenerationSettingsInputSchema.safeParse({ outputLanguage: "es" }).success).toBe(false);
    expect(GenerationSettingsInputSchema.safeParse({ notes: "x".repeat(2001) }).success).toBe(false);
  });

  it("templateId: input accepts ats/designed only; resolved default ats; letters stay ats; legacy rows parse (phase 8)", () => {
    expect(GenerationSettingsInputSchema.safeParse({ templateId: "designed" }).success).toBe(true);
    expect(GenerationSettingsInputSchema.safeParse({ templateId: "fancy" }).success).toBe(false);

    // default + explicit flow through resolveGenerationSettings (cv only)
    expect(resolveGenerationSettings({ kind: "cv", analysisLanguage: "en" })).toMatchObject({ templateId: "ats" });
    expect(
      resolveGenerationSettings({ kind: "cv", analysisLanguage: "en", input: { templateId: "designed" } }),
    ).toMatchObject({ templateId: "designed" });
    expect(
      resolveGenerationSettings({ kind: "cover_letter", analysisLanguage: "en", input: { templateId: "designed" } }),
    ).toMatchObject({ templateId: "ats" }); // one template for letters

    // templateId is optional on the stored schema — legacy settings rows parse untouched
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, summaryMaxWords: 60 }).success).toBe(true);
    expect(GenerationSettingsSchema.safeParse({ ...validSettings, summaryMaxWords: 60 }).data).not.toHaveProperty(
      "templateId",
    );
    expect(
      GenerationSettingsSchema.safeParse({ ...validSettings, summaryMaxWords: 60, templateId: "designed" }).success,
    ).toBe(true);
  });

  it("de is an explicit output language; the detection default stays fr-else-en (phase 8)", () => {
    expect(
      resolveGenerationSettings({ kind: "cv", analysisLanguage: "de", input: { outputLanguage: "de" } }),
    ).toMatchObject({ outputLanguage: "de" });
    expect(resolveGenerationSettings({ kind: "cv", analysisLanguage: "de" })).toMatchObject({
      outputLanguage: "en", // no auto-de default — de is user-selected
    });
  });

  it("resolves defaults: analysis language, budget 2, tone professional, summary 60 words", () => {
    expect(resolveGenerationSettings({ kind: "cv", analysisLanguage: "fr" })).toEqual({
      outputLanguage: "fr",
      pageBudget: 2,
      tone: "professional",
      summaryMaxWords: 60,
      templateId: "ats",
    });
    expect(resolveGenerationSettings({ kind: "cv", analysisLanguage: "en" })).toMatchObject({
      outputLanguage: "en",
    });
    // explicit selection overrides the analysis language
    expect(
      resolveGenerationSettings({ kind: "cv", analysisLanguage: "fr", input: { outputLanguage: "en" } }),
    ).toMatchObject({ outputLanguage: "en" });
  });

  it("fixes the cover-letter page budget at 1 regardless of input", () => {
    expect(
      resolveGenerationSettings({ kind: "cover_letter", analysisLanguage: "en", input: { pageBudget: 3 } }),
    ).toMatchObject({ pageBudget: 1, tone: "professional" });
    expect(resolveGenerationSettings({ kind: "cover_letter", analysisLanguage: "fr" })).toMatchObject({
      pageBudget: 1,
      outputLanguage: "fr",
    });
  });

  it("summaryMaxWords: default 60, bounds 30..120 (int), letter path keeps it", () => {
    // absent input defaults to 60 on both kinds
    expect(resolveGenerationSettings({ kind: "cv", analysisLanguage: "en" })).toMatchObject({
      summaryMaxWords: 60,
    });
    expect(resolveGenerationSettings({ kind: "cover_letter", analysisLanguage: "fr" })).toMatchObject({
      summaryMaxWords: 60,
    });
    // explicit input wins
    expect(
      resolveGenerationSettings({ kind: "cv", analysisLanguage: "en", input: { summaryMaxWords: 90 } }),
    ).toMatchObject({ summaryMaxWords: 90 });

    for (const good of [30, 120]) {
      expect(GenerationSettingsInputSchema.safeParse({ summaryMaxWords: good }).success).toBe(true);
      expect(GenerationSettingsSchema.safeParse({ ...validSettings, summaryMaxWords: good }).success).toBe(
        true,
      );
    }
    for (const bad of [29, 121, 60.5]) {
      expect(GenerationSettingsInputSchema.safeParse({ summaryMaxWords: bad }).success).toBe(false);
      expect(GenerationSettingsSchema.safeParse({ ...validSettings, summaryMaxWords: bad }).success).toBe(
        false,
      );
    }
  });
});

describe("claim ids", () => {
  it("builders emit the exact stable namespaces", () => {
    expect(summaryClaimId()).toBe("summary");
    expect(experienceClaimId("exp1", 2)).toBe("exp.exp1.2");
    expect(projectClaimId("proj1", 1)).toBe("proj.proj1.1");
    expect(educationClaimId("edu1")).toBe("edu.edu1");
    expect(certificationClaimId("cert1")).toBe("cert.cert1");
    expect(letterClaimId(3)).toBe("letter.3");
  });

  it("parses back what the builders emit (roundtrip)", () => {
    expect(parseClaimId(summaryClaimId())).toEqual({ kind: "summary" });
    expect(parseClaimId(experienceClaimId("exp1", 2))).toEqual({
      kind: "experience",
      experienceId: "exp1",
      n: 2,
    });
    expect(parseClaimId(projectClaimId("proj1", 1))).toEqual({ kind: "project", projectId: "proj1", n: 1 });
    expect(parseClaimId(educationClaimId("edu1"))).toEqual({ kind: "education", educationId: "edu1" });
    expect(parseClaimId(certificationClaimId("cert1"))).toEqual({
      kind: "certification",
      certificationId: "cert1",
    });
    expect(parseClaimId(letterClaimId(3))).toEqual({ kind: "letter", n: 3 });
    expect(parseClaimId("not-a-claim")).toBeNull();
  });

  it("expTitle namespace roundtrips and never collides with exp bullets", () => {
    expect(titleClaimId("e1")).toBe("expTitle.e1");
    expect(parseClaimId(titleClaimId("e1"))).toEqual({ kind: "experienceTitle", experienceId: "e1" });
    // bullet claims keep their namespace; title ids are exactly two segments
    expect(parseClaimId("exp.e1.1")).toEqual({ kind: "experience", experienceId: "e1", n: 1 });
    expect(parseClaimId("expTitle.e1.1")).toBeNull();
    expect(parseClaimId("expTitle.")).toBeNull();
  });
});

describe("claim fingerprint", () => {
  it("is stable for identical text+evidence and order-insensitive over evidence", () => {
    const a = claimFingerprint("Led a team of 5 engineers", ["b1", "b2"]);
    const b = claimFingerprint("Led a team of 5 engineers", ["b2", "b1"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("changes when the claim text changes (under normalization)", () => {
    const a = claimFingerprint("Led a team of 5 engineers", ["b1"]);
    const b = claimFingerprint("Led a team of 6 engineers", ["b1"]);
    expect(a).not.toBe(b);
  });

  it("normalizes text before hashing (accents/case/punctuation-insensitive)", () => {
    const a = claimFingerprint("Réduit les coûts de 30 %", ["b1"]);
    const b = claimFingerprint("reduit les couts de 30%", ["b1"]);
    expect(a).toBe(b);
  });

  it("changes when the evidence set changes", () => {
    expect(claimFingerprint("text", ["b1"])).not.toBe(claimFingerprint("text", ["b1", "b2"]));
  });
});

describe("stored content shapes", () => {
  it("roundtrips a full GeneratedCVContent", () => {
    const content = {
      claimIdVersion: 1,
      summary: "Backend engineer with 8 years in distributed systems.",
      summaryProvenance: [{ type: "bullet", id: "b1", snippet: "8 years distributed systems" }],
      experience: [
        {
          id: "e1",
          bullets: [
            {
              claimId: experienceClaimId("e1", 1),
              text: "Operated Kubernetes clusters in production.",
              sourceBulletIds: ["b1"],
              rationale: "directly evidenced",
            },
          ],
        },
      ],
      education: [{ id: "ed1", claimId: educationClaimId("ed1"), text: "MSc Computer Science", sourceIds: ["ed1"] }],
      projects: [
        { id: "p1", bullets: [{ claimId: projectClaimId("p1", 1), text: "Built an ATS checker.", sourceBulletIds: ["pb1"] }] },
      ],
      certifications: [
        { id: "c1", claimId: certificationClaimId("c1"), text: "CKA", sourceIds: ["c1"] },
      ],
      skills: ["Kubernetes", "Go"],
      omissions: [{ type: "experience", id: "e2", reason: "page_budget" }],
    };
    const parsed = GeneratedCVContentSchema.safeParse(content);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.omissions[0]).toEqual({ type: "experience", id: "e2", reason: "page_budget" });
    }

    // wrong claim-id namespace version is rejected
    expect(GeneratedCVContentSchema.safeParse({ ...content, claimIdVersion: 2 }).success).toBe(false);
    // omissions restored flag roundtrips
    expect(
      GeneratedCVContentSchema.safeParse({
        ...content,
        omissions: [{ type: "experience", id: "e2", reason: "page_budget", restoredMustInclude: true }],
      }).success,
    ).toBe(true);
  });

  it("roundtrips a CoverLetterContent", () => {
    const letter = {
      claimIdVersion: 1,
      paragraphs: [
        {
          claimId: letterClaimId(1),
          text: "I am excited to apply.",
          evidence: [{ type: "skill", id: "s1", snippet: "Kubernetes" }],
        },
      ],
      tone: "formal",
      omissions: [],
    };
    expect(CoverLetterContentSchema.safeParse(letter).success).toBe(true);
    expect(CoverLetterContentSchema.safeParse({ ...letter, claimIdVersion: 0 }).success).toBe(false);
  });

  it("roundtrips a ValidationReport and enforces layers/summary shape", () => {
    const report = {
      layersRun: { deterministic: true, semantic: true },
      flags: [
        {
          code: "NUMERIC_MISMATCH",
          claim: "exp.e1.1",
          severity: "blocker",
          affectedFieldIds: ["exp.e1.1"],
          sourceEvidence: [{ type: "bullet", id: "b1", snippet: "…" }],
          resolution: "pending",
        },
        {
          code: "VERBATIM_FALLBACK",
          claim: "summary",
          severity: "warning",
          resolution: "user_confirmed",
          confirmedAt: "2026-10-22T00:00:00.000Z",
        },
      ],
      summary: { blockers: 1, warnings: 1 },
    };
    expect(ValidationReportSchema.safeParse(report).success).toBe(true);
    // fail-closed core: deterministic layer is a literal true
    expect(
      ValidationReportSchema.safeParse({ ...report, layersRun: { deterministic: false, semantic: true } })
        .success,
    ).toBe(false);
    expect(ValidationReportSchema.safeParse({ ...report, layersRun: undefined }).success).toBe(false);
    expect(
      ValidationReportSchema.safeParse({ ...report, flags: [{ ...report.flags[0], severity: "fatal" }] })
        .success,
    ).toBe(false);
  });

  it("roundtrips ArtifactMeta and ClaimFingerprint", () => {
    expect(
      ArtifactMetaSchema.safeParse({
        format: "pdf",
        storagePath: "uploads/generations/v1/cv.pdf",
        sha256: "abc123",
        bytes: 1234,
        gate: "verified",
      }).success,
    ).toBe(true);
    expect(
      ArtifactMetaSchema.safeParse({ format: "html", storagePath: "x", sha256: "y", bytes: 1, gate: "none" })
        .success,
    ).toBe(false);
    expect(
      ClaimFingerprintSchema.safeParse({ fingerprint: claimFingerprint("t", ["a"]), confirmedAt: "2026-10-22T00:00:00.000Z" })
        .success,
    ).toBe(true);
  });
});

// --- Feature 005: title claims, selection record, omission vocabulary ---

describe("feature 005 shapes", () => {
  function cvContentFixture(): Record<string, unknown> {
    return {
      claimIdVersion: 1,
      summary: "Backend engineer.",
      summaryProvenance: [{ type: "bullet", id: "b1", snippet: "8 years distributed systems" }],
      experience: [
        {
          id: "e1",
          bullets: [
            { claimId: experienceClaimId("e1", 1), text: "Operated clusters.", sourceBulletIds: ["b1"] },
          ],
        },
      ],
      education: [],
      projects: [],
      certifications: [],
      skills: [],
      omissions: [],
    };
  }

  it("experience title is optional (legacy content parses) and roundtrips when present", () => {
    expect(GeneratedCVContentSchema.safeParse(cvContentFixture()).success).toBe(true);

    const titled = cvContentFixture();
    (titled.experience as unknown[])[0] = {
      id: "e1",
      title: { claimId: titleClaimId("e1"), text: "Senior Platform Engineer", sourceTitle: "Dev" },
      bullets: [{ claimId: experienceClaimId("e1", 1), text: "Operated clusters.", sourceBulletIds: ["b1"] }],
    };
    const parsed = GeneratedCVContentSchema.safeParse(titled);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.experience[0].title).toEqual({
        claimId: "expTitle.e1",
        text: "Senior Platform Engineer",
        sourceTitle: "Dev",
      });
    }

    // empty text / sourceTitle rejected; claimId required
    for (const title of [
      { claimId: titleClaimId("e1"), text: "", sourceTitle: "Dev" },
      { claimId: titleClaimId("e1"), text: "t", sourceTitle: "" },
      { text: "t", sourceTitle: "Dev" },
    ]) {
      const broken = cvContentFixture();
      (broken.experience as unknown[])[0] = {
        id: "e1",
        title,
        bullets: [{ claimId: experienceClaimId("e1", 1), text: "Operated clusters.", sourceBulletIds: ["b1"] }],
      };
      expect(GeneratedCVContentSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("omission reason is the closed three-value vocabulary", () => {
    for (const reason of ["page_budget", "selection", "unwritten"] as const) {
      expect(OmissionSchema.safeParse({ type: "experience", id: "e2", reason }).success).toBe(true);
    }
    expect(OmissionSchema.safeParse({ type: "experience", id: "e2", reason: "other" }).success).toBe(false);
    expect(OmissionSchema.safeParse({ type: "experience", id: "e2", reason: "" }).success).toBe(false);
    expect(OmissionSchema.safeParse({ type: "experience", id: "e2" }).success).toBe(false);
  });

  it("SelectionRecord parses the persisted shape and rejects malformed entries", () => {
    const record = {
      included: [
        {
          entryId: "e1",
          kind: "experience",
          rank: 1,
          score: 0.87,
          basis: {
            evidenceRefs: [{ type: "bullet", id: "b1", snippet: "led 5 engineers" }],
            methodCredits: ["exact", "semantic"],
            recency: 0.9,
          },
        },
        {
          entryId: "ed1",
          kind: "education",
          rank: 2,
          score: 0.5,
          basis: { evidenceRefs: [], methodCredits: [], recency: 0 },
        },
      ],
      generatedAt: "2026-10-24T00:00:00.000Z",
    };
    expect(SelectionRecordSchema.safeParse(record).success).toBe(true);

    const first = record.included[0] as Record<string, unknown>;
    // kind constrained to the four section kinds
    expect(
      SelectionRecordSchema.safeParse({ ...record, included: [{ ...first, kind: "skill" }] }).success,
    ).toBe(false);
    // rank is a 1-based integer
    expect(
      SelectionRecordSchema.safeParse({ ...record, included: [{ ...first, rank: 0 }] }).success,
    ).toBe(false);
    expect(
      SelectionRecordSchema.safeParse({ ...record, included: [{ ...first, rank: 1.5 }] }).success,
    ).toBe(false);
    // recency is 0..1
    expect(
      SelectionRecordSchema.safeParse({
        ...record,
        included: [{ ...first, basis: { ...(first.basis as Record<string, unknown>), recency: 1.5 } }],
      }).success,
    ).toBe(false);
    expect(SelectionRecordSchema.safeParse({ ...record, generatedAt: "" }).success).toBe(false);
  });
});
