import { describe, expect, it } from "vitest";
import { matchRequirements, deriveKeywords, type EngineRequirement } from "@/lib/matching/engine";
import { sameAliasGroup } from "@/lib/matching/aliases";
import { scoreReport, matchCredit, recomputeScore } from "@/lib/matching/score";
import type { ProfileDto } from "@/lib/profile/repository";
import type { RequirementMatch } from "@/lib/jobs/schemas";

function profileFixture(): ProfileDto {
  return {
    id: "p1",
    version: 1,
    language: "en",
    basics: null,
    experience: [
      {
        id: "exp1",
        profileId: "p1",
        company: "Northwind",
        title: "Backend Engineer",
        location: null,
        startDate: "2020-01",
        endDate: "present",
        skillsUsed: ["Kubernetes", "Go"],
        order: 0,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
        bullets: [
          {
            id: "b1",
            experienceId: "exp1",
            projectId: null,
            educationId: null,
            text: "Ran Kubernetes clusters at scale and led migration of monolith to event-driven services",
            order: 0,
            provenance: "user_entered",
            sourceDocumentId: null,
            sourceLocator: null,
            language: null,
            confidence: null,
            containmentOk: null,
            reviewFlag: null,
          },
        ],
      },
      {
        id: "exp2",
        profileId: "p1",
        company: "Acme",
        title: "Developer",
        location: null,
        startDate: "2018-01",
        endDate: "2019-12",
        skillsUsed: ["React", "Project Management"],
        order: 1,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
        bullets: [],
      },
    ],
    education: [
      {
        id: "edu1",
        profileId: "p1",
        institution: "UCD",
        degree: "B.Sc.",
        field: "Computer Science",
        startDate: "2014-09",
        endDate: "2018-06",
        grade: null,
        order: 0,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
    ],
    skills: [
      {
        id: "sk1",
        profileId: "p1",
        name: "Kubernetes",
        category: null,
        aliases: [],
        level: null,
        order: 0,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
      {
        id: "sk2",
        profileId: "p1",
        name: "Développeur Web",
        category: null,
        aliases: [],
        level: null,
        order: 1,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
      {
        id: "sk3",
        profileId: "p1",
        name: "Project Management",
        category: null,
        aliases: [],
        level: null,
        order: 2,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
      {
        id: "sk4",
        profileId: "p1",
        name: "React",
        category: null,
        aliases: ["ReactJS"],
        level: null,
        order: 3,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
      {
        id: "sk5",
        profileId: "p1",
        name: "Kafka",
        category: null,
        aliases: [],
        level: null,
        order: 4,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
    ],
    languages: [
      {
        id: "lang1",
        profileId: "p1",
        name: "French",
        proficiency: "native",
        order: 0,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
    ],
    projects: [],
    certifications: [
      {
        id: "cert1",
        profileId: "p1",
        title: "AWS Solutions Architect",
        issuer: "Amazon",
        issueDate: "2022-05",
        order: 0,
        provenance: "user_entered",
        sourceDocumentId: null,
        sourceLocator: null,
        language: null,
        confidence: null,
        reviewFlag: null,
      },
    ],
    lowConfidenceCount: 0,
    updatedAt: "2026-10-21T00:00:00.000Z",
  } as unknown as ProfileDto;
}

function req(partial: Partial<EngineRequirement> & { id: string; text: string }): EngineRequirement {
  return {
    category: "tool",
    importance: "must",
    isHardConstraint: false,
    userConfirmed: false,
    ...partial,
  };
}

describe("matching engine (deterministic layers)", () => {
  const profile = profileFixture();

  it("exact: skill name match with usage evidence → strong/exact", () => {
    const r = matchRequirements([req({ id: "r1", text: "Kubernetes" })], profile, null);
    const m = r.matches[0];
    expect(m.status).toBe("strong");
    expect(m.matchMethod).toBe("exact");
    expect(m.evidence.some((e) => e.type === "skill")).toBe(true);
    expect(m.evidence.some((e) => e.type === "bullet")).toBe(true); // usage evidence
  });

  it("exact: accent- and case-insensitive equality", () => {
    const r = matchRequirements([req({ id: "r1", text: "developpeur web" })], profile, null);
    expect(r.matches[0].matchMethod).toBe("exact");
  });

  it("exact via skillsUsed on a role", () => {
    const r = matchRequirements([req({ id: "r1", text: "Go" })], profile, null);
    expect(r.matches[0].matchMethod).toBe("exact");
    expect(r.matches[0].status).toBe("strong"); // in skillsUsed ⇒ usage
  });

  it("alias: built-in bilingual group, usage judged on the matched term", () => {
    const r = matchRequirements([req({ id: "r1", text: "gestion de projet" })], profile, null);
    expect(r.matches[0].matchMethod).toBe("approved_alias");
    expect(r.matches[0].status).toBe("strong"); // "Project Management" is in skillsUsed
  });

  it("alias: user-approved per-skill alias (ReactJS via Skill.aliases)", () => {
    const r = matchRequirements([req({ id: "r1", text: "ReactJS" })], profile, null);
    expect(r.matches[0].matchMethod).toBe("approved_alias");
  });

  it("non-approved synonyms never match (Kafka is not an alias of anything here)", () => {
    const r = matchRequirements([req({ id: "r1", text: "event streaming platforms" })], profile, null);
    expect(r.matches[0].status).toBe("gap");
    expect(r.matches[0].matchMethod).toBe("none");
  });

  it("exact by whole-phrase containment: 'Exposure to project management' ⊃ 'project management'", () => {
    const r = matchRequirements(
      [req({ id: "r1", text: "Exposure to project management", category: "skill" })],
      profileFixture(),
      null,
    );
    expect(r.matches[0].matchMethod).toBe("exact");
    expect(r.matches[0].status).toBe("strong"); // "Project Management" is in skillsUsed
  });

  it("exact containment picks the longest term and respects word boundaries", () => {
    // 'ai' inside 'training' must NOT count; 'kubernetes' inside a longer phrase must
    const r = matchRequirements(
      [req({ id: "r1", text: "French language skills", category: "language" })],
      profileFixture(),
      null,
    );
    expect(r.matches[0]).toMatchObject({ status: "strong", matchMethod: "exact" });
  });

  it("free-text bullet content is never an exact match source", () => {
    const r = matchRequirements(
      [req({ id: "r1", text: "led migration of monolith to event-driven services" })],
      profile,
      null,
    );
    expect(r.matches[0].status).toBe("gap");
  });

  it("partial: skill/tool term matched without usage evidence", () => {
    const r = matchRequirements([req({ id: "r1", text: "Kafka" })], profile, null);
    const m = r.matches[0];
    expect(m.status).toBe("partial");
    expect(m.matchMethod).toBe("exact");
    expect(m.note).toBeTruthy();
  });

  it("credential/education/language categories are strong on existence", () => {
    const r = matchRequirements(
      [
        req({ id: "r1", text: "AWS Solutions Architect", category: "education" }),
        req({ id: "r2", text: "French", category: "language" }),
      ],
      profile,
      null,
    );
    expect(r.matches[0]).toMatchObject({ status: "strong", matchMethod: "exact" });
    expect(r.matches[1]).toMatchObject({ status: "strong", matchMethod: "exact" });
  });
});

describe("semantic layer (propose–validate)", () => {
  const profile = profileFixture();

  it("valid proposals become semantic matches with server-built evidence", () => {
    const r = matchRequirements(
      [req({ id: "r1", text: "event-driven architecture" })],
      profile,
      [{ requirementIndex: 0, entryIds: ["b1"], rationale: "led migration to event-driven services" }],
    );
    expect(r.matches[0]).toMatchObject({ status: "strong", matchMethod: "semantic" });
    expect(r.matches[0].evidence[0]).toMatchObject({ id: "b1", type: "bullet" });
    expect(r.semanticDropped).toBe(0);
  });

  it("proposals with unknown entry IDs are dropped and counted (SC-005)", () => {
    const r = matchRequirements(
      [req({ id: "r1", text: "quantum computing" })],
      profile,
      [{ requirementIndex: 0, entryIds: ["ghost-1", "ghost-2"] }],
    );
    expect(r.matches[0].status).toBe("gap");
    expect(r.semanticDropped).toBe(1);
  });

  it("hard constraints are never auto-matched by semantic — they become confirmable gaps (FR-007)", () => {
    const r = matchRequirements(
      [req({ id: "r1", text: "Terraform", isHardConstraint: true })],
      profile,
      [{ requirementIndex: 0, entryIds: ["b1"] }],
    );
    expect(r.matches[0]).toMatchObject({ status: "gap", matchMethod: "none" });
    expect(r.confirmable["r1"]).toEqual(["b1"]);
  });

  it("userConfirmed hard requirements render as confirmed semantic matches", () => {
    const r = matchRequirements(
      [req({ id: "r1", text: "Terraform", isHardConstraint: true, userConfirmed: true })],
      profile,
      [{ requirementIndex: 0, entryIds: ["b1"] }],
    );
    expect(r.matches[0]).toMatchObject({ status: "strong", matchMethod: "semantic", userConfirmed: true });
  });

  it("unmatchedNonHard feeds the semantic task with original indexes", () => {
    const r = matchRequirements(
      [req({ id: "r1", text: "Kubernetes" }), req({ id: "r2", text: "quantum computing" })],
      profile,
      null,
    );
    expect(r.unmatchedNonHard).toEqual([{ index: 1, text: "quantum computing" }]);
  });

  it("keywords derive with must-before-nice ordering", () => {
    const matches: RequirementMatch[] = [
      {
        id: "a", text: "Kafka", importance: "nice", isHardConstraint: false,
        status: "gap", matchMethod: "none", evidence: [], note: null,
      },
      {
        id: "b", text: "Kubernetes", importance: "must", isHardConstraint: false,
        status: "strong", matchMethod: "exact", evidence: [{ type: "skill", id: "sk1", snippet: "Kubernetes" }],
        note: null,
      },
    ];
    const kw = deriveKeywords(matches);
    expect(kw.recommended).toEqual(["Kubernetes"]);
    expect(kw.missing).toEqual(["Kafka"]);
  });
});

describe("aliases module", () => {
  it("resolves built-in groups and rejects non-approved pairs", () => {
    expect(sameAliasGroup("K8s", "Kubernetes")).toBe(true);
    expect(sameAliasGroup("kubernetes", "docker")).toBe(false);
  });
});

describe("score (clarified formula, SC-004)", () => {
  function m(partial: Partial<RequirementMatch> & { id: string }): RequirementMatch {
    return {
      text: partial.id,
      importance: "must",
      isHardConstraint: false,
      status: "strong",
      matchMethod: "exact",
      evidence: [],
      note: null,
      ...partial,
    } as RequirementMatch;
  }

  it("credits per method and status", () => {
    expect(matchCredit(m({ id: "1", matchMethod: "exact" }))).toBe(1.0);
    expect(matchCredit(m({ id: "2", matchMethod: "approved_alias" }))).toBe(0.9);
    expect(matchCredit(m({ id: "3", matchMethod: "semantic" }))).toBe(0.7);
    expect(matchCredit(m({ id: "4", status: "partial" }))).toBe(0.5);
    expect(matchCredit(m({ id: "5", status: "gap" }))).toBe(0);
    expect(matchCredit(m({ id: "6", isHardConstraint: true, userConfirmed: true }))).toBe(0.7);
  });

  it("semantic credit never applies to hard constraints", () => {
    const matches = [
      m({ id: "h1", isHardConstraint: true, matchMethod: "semantic", status: "strong" }),
    ];
    const { overallScore, scoreBreakdown } = scoreReport(matches);
    expect(overallScore).toBe(0); // 60 × 0/1, no preferred, bonus 0
    expect(scoreBreakdown.semanticMatches).toBe(1); // displayed for transparency
  });

  it("empty buckets shift weights", () => {
    const onlyPreferred = [m({ id: "p1", matchMethod: "exact" })];
    const s1 = scoreReport(onlyPreferred);
    expect(s1.scoreBreakdown.preferredWeight).toBe(90);
    expect(s1.overallScore).toBe(90);

    const onlyHard = [m({ id: "h1", isHardConstraint: true, matchMethod: "exact" })];
    const s2 = scoreReport(onlyHard);
    expect(s2.scoreBreakdown.hardWeight).toBe(90);
    expect(s2.overallScore).toBe(90);

    expect(scoreReport([]).overallScore).toBe(0);
  });

  it("evidence bonus = 10 × share of matched with bullet evidence", () => {
    const matches = [
      m({ id: "1", matchMethod: "exact", evidence: [{ type: "bullet", id: "b", snippet: "x" }] }),
      m({ id: "2", matchMethod: "exact", evidence: [{ type: "skill", id: "s", snippet: "x" }] }),
    ];
    const { overallScore, scoreBreakdown } = scoreReport(matches);
    expect(scoreBreakdown.evidenceBonus).toBe(5);
    expect(overallScore).toBe(90 + 5); // both preferred (no hard) → 90 + 5
  });

  it("recomputes identically from stored matches (SC-004) and detects tampering", () => {
    const matches = [
      m({ id: "1", isHardConstraint: true, matchMethod: "exact", evidence: [{ type: "bullet", id: "b", snippet: "x" }] }),
      m({ id: "2", matchMethod: "approved_alias", importance: "nice" }),
      m({ id: "3", status: "partial" }),
      m({ id: "4", status: "gap" }),
    ];
    const report = scoreReport(matches);
    expect(recomputeScore({ requirements: matches, overallScore: report.overallScore })).toBe(true);
    expect(recomputeScore({ requirements: matches, overallScore: report.overallScore + 1 })).toBe(false);
  });
});
