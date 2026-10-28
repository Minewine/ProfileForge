import { describe, expect, it } from "vitest";
import type { EvidenceRef, MatchReport, RequirementMatch } from "@/lib/jobs/schemas";
import {
  METHOD_WEIGHTS,
  RECENCY_DECAY_YEARS,
  SELECTION_CAPS,
  buildCVPlan,
  recencyScore,
  resolveEvidenceRefs,
  selectionCap,
  type PinnedSnapshot,
} from "@/lib/generation/plan";
import { SelectionRecordSchema, experienceClaimId, titleClaimId } from "@/lib/generation/schemas";

// --- fixtures (pinned-snapshot shape = serializeProfile output) ---

function bullet(o: { id: string; text: string; confidence?: number | null; containmentOk?: boolean | null }) {
  return {
    id: o.id,
    text: o.text,
    order: 0,
    ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
    ...(o.containmentOk !== undefined ? { containmentOk: o.containmentOk } : {}),
  };
}

function experience(
  o: {
    id: string;
    company?: string;
    title?: string;
    start?: string;
    end?: string;
    bullets?: ReturnType<typeof bullet>[];
  } = { id: "e1" },
) {
  return {
    id: o.id,
    company: o.company ?? "Acme",
    title: o.title ?? "Engineer",
    location: null,
    startDate: o.start ?? "2020-01",
    endDate: o.end ?? "2024-06",
    skillsUsed: [] as string[],
    order: 0,
    bullets: o.bullets ?? [],
  };
}

function snapshotFixture(overrides: Partial<PinnedSnapshot> = {}): PinnedSnapshot {
  return {
    id: "p1",
    version: 4,
    language: "en",
    basics: null,
    experience: [],
    education: [],
    skills: [],
    languages: [],
    projects: [],
    certifications: [],
    ...overrides,
  } as PinnedSnapshot;
}

function ref(type: EvidenceRef["type"], id: string, snippet = "snippet"): EvidenceRef {
  return { type, id, snippet };
}

function requirement(o: {
  id: string;
  text: string;
  importance?: "must" | "nice";
  hard?: boolean;
  status?: RequirementMatch["status"];
  method?: RequirementMatch["matchMethod"];
  evidence?: EvidenceRef[];
}): RequirementMatch {
  return {
    id: o.id,
    text: o.text,
    importance: o.importance ?? "nice",
    isHardConstraint: o.hard ?? false,
    status: o.status ?? "strong",
    matchMethod: o.method ?? "none",
    evidence: o.evidence ?? [],
    note: null,
  };
}

function reportFixture(requirements: RequirementMatch[], recommendedKeywords: string[] = []): MatchReport {
  return {
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
    requirements,
    recommendedKeywords,
    missingKeywords: [],
    semanticDropped: 0,
  };
}

const NOW = new Date("2026-01-01T00:00:00Z");

// --- resolveEvidenceRefs (research R5: dangling → skip, never fabricate) ---

describe("resolveEvidenceRefs", () => {
  it("drops evidence refs that dangle against the pinned snapshot and keeps resolvable ones", () => {
    const snapshot = snapshotFixture({
      experience: [experience({ id: "e1", bullets: [bullet({ id: "b1", text: "Ran clusters" })] })],
      skills: [{ id: "s1", name: "Kubernetes" }],
    });
    const report = reportFixture([
      requirement({
        id: "r1",
        text: "Kubernetes",
        method: "exact",
        evidence: [ref("skill", "s1"), ref("bullet", "bGone"), ref("education", "edGone")],
      }),
    ]);

    const resolved = resolveEvidenceRefs(report, snapshot);
    expect(resolved.report.requirements[0].evidence).toEqual([ref("skill", "s1")]);
    expect(resolved.dangling.map((e) => e.id).sort()).toEqual(["bGone", "edGone"]);
  });

  it("keeps the report untouched when every ref resolves", () => {
    const snapshot = snapshotFixture({ skills: [{ id: "s1", name: "Kubernetes" }] });
    const report = reportFixture([requirement({ id: "r1", text: "Kubernetes", evidence: [ref("skill", "s1")] })]);
    const resolved = resolveEvidenceRefs(report, snapshot);
    expect(resolved.dangling).toEqual([]);
    expect(resolved.report.requirements[0].evidence).toEqual(report.requirements[0].evidence);
  });
});

// --- ranking (contracts/generation-pipeline.md stage 2, weights v1) ---

describe("buildCVPlan ranking", () => {
  it("orders entries by method-weighted evidence links: exact > approved_alias > semantic", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({ id: "e1", end: "2024-06", bullets: [bullet({ id: "b1", text: "Shipped module one" })] }),
        experience({ id: "e2", end: "2024-06", bullets: [bullet({ id: "b2", text: "Shipped module two" })] }),
        experience({ id: "e3", end: "2024-06", bullets: [bullet({ id: "b3", text: "Shipped module three" })] }),
      ],
    });
    const report = reportFixture([
      requirement({ id: "r1", text: "Alpha mandate", method: "exact", evidence: [ref("bullet", "b3")] }),
      requirement({ id: "r2", text: "Beta mandate", method: "approved_alias", evidence: [ref("bullet", "b1")] }),
      requirement({ id: "r3", text: "Gamma mandate", method: "semantic", evidence: [ref("bullet", "b2")] }),
    ]);

    const plan = buildCVPlan({ snapshot, report, now: NOW });
    expect(plan.items.filter((i) => i.kind !== "title").map((i) => i.key)).toEqual([
      experienceClaimId("e3", 1), // exact 1.0
      experienceClaimId("e1", 1), // approved_alias 0.9
      experienceClaimId("e2", 1), // semantic 0.7
    ]);
    expect(METHOD_WEIGHTS).toEqual({ exact: 1.0, approved_alias: 0.9, semantic: 0.7 });
  });

  it("orders entries by recency when nothing else differs (present newest)", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({ id: "e-old", end: "2014-06", bullets: [bullet({ id: "b-old", text: "Shipped module one" })] }),
        experience({ id: "e-present", end: "present", bullets: [bullet({ id: "b-pres", text: "Shipped module two" })] }),
        experience({ id: "e-recent", end: "2024-06", bullets: [bullet({ id: "b-rec", text: "Shipped module three" })] }),
      ],
    });

    const plan = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW });
    expect(plan.items.filter((i) => i.kind !== "title").map((i) => i.entryId)).toEqual(["e-present", "e-recent", "e-old"]);
  });

  it("orders bullets within an entry by impact (quantified outcomes first)", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({
          id: "e1",
          bullets: [
            bullet({ id: "b-plain", text: "Improved service reliability across regions" }),
            bullet({ id: "b-nums", text: "Cut infrastructure costs by 30 percent over 6 months" }),
          ],
        }),
      ],
    });

    const plan = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW });
    expect(plan.items.filter((i) => i.kind !== "title").map((i) => i.key)).toEqual([experienceClaimId("e1", 1), experienceClaimId("e1", 2)]);
    expect(plan.items[0].sourceIds).toEqual(["b-nums"]);
  });

  it("orders bullets by evidence strength: more matched-requirement refs first", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({
          id: "e1",
          bullets: [
            bullet({ id: "b3", text: "Shipped module three" }),
            bullet({ id: "b1", text: "Shipped module one" }),
            bullet({ id: "b2", text: "Shipped module two" }),
          ],
        }),
      ],
    });
    const report = reportFixture([
      requirement({ id: "r1", text: "Alpha mandate", method: "exact", evidence: [ref("bullet", "b1")] }),
      requirement({ id: "r2", text: "Beta mandate", method: "exact", evidence: [ref("bullet", "b1")] }),
      requirement({ id: "r3", text: "Gamma mandate", method: "exact", evidence: [ref("bullet", "b2")] }),
    ]);

    const plan = buildCVPlan({ snapshot, report, now: NOW });
    expect(plan.items.filter((i) => i.kind !== "title").map((i) => i.sourceIds[0])).toEqual(["b1", "b2", "b3"]);
  });

  it("lifts entries whose text overlaps requirements ∪ recommendedKeywords", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({ id: "eB", bullets: [bullet({ id: "bB", text: "Wrote technical documentation" })] }),
        experience({ id: "eA", bullets: [bullet({ id: "bA", text: "Ran Kubernetes and Go in production" })] }),
      ],
    });
    const report = reportFixture(
      [requirement({ id: "r1", text: "Kubernetes in production", status: "gap", method: "none" })],
      ["Go"],
    );

    const plan = buildCVPlan({ snapshot, report, now: NOW });
    expect(plan.items[0].entryId).toBe("eA");
  });

  it("ranks experience entries as units — a low-bullet entry can outrank a higher single bullet", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({
          id: "e1",
          end: "2024-06",
          bullets: [bullet({ id: "b1a", text: "Shipped module one" }), bullet({ id: "b1b", text: "Shipped module two" })],
        }),
        experience({
          id: "e2",
          end: "2024-06",
          bullets: [bullet({ id: "b2a", text: "Cut costs by 40 percent for module three" })],
        }),
      ],
    });
    // entry-level evidence (skillsUsed match → the engine cites the experience id)
    const report = reportFixture([
      requirement({ id: "r1", text: "Alpha mandate", method: "exact", evidence: [ref("bullet", "e1")] }),
    ]);

    const plan = buildCVPlan({ snapshot, report, now: NOW });
    const ids = plan.items.map((i) => i.entryId);
    expect(ids.indexOf("e2")).toBeGreaterThan(-1);
    expect(ids.indexOf("e1")).toBeLessThan(ids.indexOf("e2")); // whole entry first
    // bullet order within e1 preserves the snapshot order on ties
    expect(plan.items.slice(0, 2).map((i) => i.sourceIds[0])).toEqual(["b1a", "b1b"]);
  });
});

describe("recencyScore", () => {
  it("present/null ⇒ 1.0, linear decay to 0 at 15 years, clamped beyond", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    expect(recencyScore("present", now)).toBe(1);
    expect(recencyScore(null, now)).toBe(1);
    expect(recencyScore(undefined, now)).toBe(1);
    expect(recencyScore("2025-01", now)).toBeCloseTo(1, 6);
    expect(recencyScore("2020-01", now)).toBeCloseTo(1 - 5 / RECENCY_DECAY_YEARS, 3);
    expect(recencyScore("2015-01", now)).toBeCloseTo(1 - 10 / RECENCY_DECAY_YEARS, 3);
    expect(recencyScore("2010-01", now)).toBe(0);
    expect(recencyScore("2000-01", now)).toBe(0);
  });
});

// --- deterministic skills list (R7: no LLM involvement) ---

describe("buildCVPlan skills list", () => {
  it("exact/approved-alias matches only, rendered in JD terminology, importance then credit", () => {
    const snapshot = snapshotFixture({
      skills: [
        { id: "s-kube", name: "Kubernetes" },
        { id: "s-terraform", name: "Terraform" },
        { id: "s-kafka", name: "Kafka" },
      ],
    });
    const report = reportFixture([
      requirement({ id: "r-kube", text: "Kubernetes", importance: "nice", method: "exact", evidence: [ref("skill", "s-kube")] }),
      requirement({
        id: "r-terraform",
        text: "Terraform (infrastructure as code)",
        importance: "must",
        method: "approved_alias",
        evidence: [ref("skill", "s-terraform")],
      }),
      requirement({ id: "r-kafka", text: "Kafka", importance: "nice", method: "approved_alias", evidence: [ref("skill", "s-kafka")] }),
      requirement({ id: "r-sem", text: "Distributed systems design", method: "semantic", evidence: [ref("bullet", "b1")] }),
      requirement({ id: "r-gap", text: "Rust", status: "gap", method: "none" }),
    ]);

    const plan = buildCVPlan({ snapshot, report, now: NOW });
    // must before nice; within nice, exact (1.0) before alias (0.9); semantic/gap excluded
    expect(plan.skills).toEqual(["Terraform (infrastructure as code)", "Kubernetes", "Kafka"]);
  });

  it("excludes skill matches whose evidence dangles in the pinned snapshot (stale analysis)", () => {
    const snapshot = snapshotFixture({ skills: [{ id: "s-live", name: "Kubernetes" }] });
    const report = reportFixture([
      requirement({ id: "r-live", text: "Kubernetes", method: "exact", evidence: [ref("skill", "s-live")] }),
      requirement({ id: "r-gone", text: "Terraform", method: "exact", evidence: [ref("skill", "s-gone")] }),
    ]);
    const resolved = resolveEvidenceRefs(report, snapshot);

    const plan = buildCVPlan({ snapshot, report: resolved.report, now: NOW });
    expect(plan.skills).toEqual(["Kubernetes"]);
  });
});

// --- must-include (restored omissions are exempt from demotion; consumed in US5) ---

describe("buildCVPlan must-include", () => {
  it("flags items targeted by restoredMustInclude omissions (by key, source id, or entry id)", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({ id: "e1", bullets: [bullet({ id: "b1", text: "Shipped module one" })] }),
        experience({ id: "e2", bullets: [bullet({ id: "b2", text: "Shipped module two" })] }),
      ],
    });

    const plan = buildCVPlan({
      snapshot,
      report: reportFixture([]),
      restoredOmissions: [{ type: "experience", id: "e2", reason: "page_budget", restoredMustInclude: true }],
      now: NOW,
    });
    const byKey = new Map(plan.items.map((i) => [i.key, i]));
    expect(byKey.get(experienceClaimId("e2", 1))?.mustInclude).toBe(true);
    expect(byKey.get(experienceClaimId("e1", 1))?.mustInclude).toBe(false);
    expect(plan.mustIncludeKeys).toEqual([experienceClaimId("e2", 1), titleClaimId("e2")]); // both items of the restored entry
  });

  it("joins restored skill omissions into mustIncludeSkills (normalized skill-text match)", () => {
    const snapshot = snapshotFixture({ skills: [{ id: "s1", name: "Kubernetes" }] });
    const report = reportFixture([
      requirement({ id: "r1", text: "Kubernetes", method: "exact", evidence: [ref("skill", "s1")] }),
    ]);
    const plan = buildCVPlan({
      snapshot,
      report,
      restoredOmissions: [{ type: "skill", id: "Kubernetes", reason: "page_budget", restoredMustInclude: true }],
      now: NOW,
    });
    expect(plan.skills).toEqual(["Kubernetes"]);
    expect(plan.mustIncludeSkills).toEqual(["Kubernetes"]);

    // without restored skills the field stays unset (nothing must-include)
    const plain = buildCVPlan({ snapshot, report, now: NOW });
    expect(plain.mustIncludeSkills).toBeUndefined();
  });
});

// --- plan item shape (payload-minimized: id + source text + entry meta only) ---

describe("buildCVPlan items", () => {
  it("emits stable claim-id keys across all four kinds with minimized payloads", () => {
    const snapshot = snapshotFixture({
      experience: [
        experience({
          id: "e1",
          company: "Acme",
          title: "Platform Engineer",
          start: "2021-01",
          end: "present",
          bullets: [bullet({ id: "b1", text: "Ran clusters" })],
        }),
      ],
      projects: [{ id: "p1", name: "ATS Checker", bullets: [bullet({ id: "pb1", text: "Built checker" })] }],
      education: [{ id: "ed1", institution: "McGill", degree: "BSc", field: "Computer Science", startDate: "2012-09", endDate: "2016-05" }],
      certifications: [{ id: "c1", title: "CKA", issuer: "CNCF", issueDate: "2023-04" }],
    });

    const plan = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW });
    expect(plan.items.filter((i) => i.kind !== "title").map((i) => i.key)).toEqual(["exp.e1.1", "proj.p1.1", "edu.ed1", "cert.c1"]);
    expect(plan.items.map((i) => i.kind)).toEqual(["experience", "title", "project", "education", "certification"]);
    expect(plan.items[0].sourceText).toEqual(["Ran clusters"]);
    expect(plan.items[1].key).toBe("expTitle.e1"); // the title claim rides with its entry
    expect(plan.items[1].sourceText).toEqual(["Platform Engineer"]);
    expect(plan.items[0].sourceIds).toEqual(["b1"]);
    expect(plan.items[0].entryMeta).toEqual({ title: "Platform Engineer", company: "Acme", dates: "2021-01 – present" });
    expect(plan.items[3].sourceText).toEqual(["BSc", "Computer Science", "McGill"]);
    expect(plan.items[4].sourceText).toEqual(["CKA", "CNCF"]);

    // summary sources are the top-scored bullet items; provenance resolves into the snapshot
    expect(plan.summarySources).toEqual(["Ran clusters", "Built checker"]);
    expect(plan.summaryEvidence).toContainEqual({ type: "bullet", id: "b1", snippet: "Ran clusters" });
  });
});

// --- selection cut (feature 005 US1, contracts/selection-rewriting.md) ---

/** Six experience entries whose scores differ only by recency — a strictly
 *  decreasing deterministic rank: e1 (present) … e6 (2015-06). */
function cutSnapshot() {
  const ends = ["present", "2025-06", "2024-06", "2023-06", "2020-06", "2015-06"];
  return snapshotFixture({
    experience: ends.map((end, i) =>
      experience({ id: `e${i + 1}`, end, bullets: [bullet({ id: `b${i + 1}`, text: `Shipped module ${i + 1}` })] }),
    ),
  });
}

describe("selection caps and budget scaling (US1)", () => {
  it("documents the contract caps (budget 2) and scales them per budget", () => {
    expect(SELECTION_CAPS).toEqual({ experience: 4, project: 2, education: 3, certification: 3 });
    for (const kind of ["experience", "project", "education", "certification"] as const) {
      expect(selectionCap(kind, 2)).toBe(SELECTION_CAPS[kind]); // budget 2 → cap
      expect(selectionCap(kind, 1)).toBe(Math.max(1, Math.floor(SELECTION_CAPS[kind] / 2))); // budget 1
      expect(selectionCap(kind, 3)).toBe(SELECTION_CAPS[kind] + 1); // budget 3
    }
  });
});

describe("buildCVPlan selection cut (US1)", () => {
  it("drafts only the top-cap entries (6 ranked experience entries → top 4); the rest are NOT plan items", () => {
    const plan = buildCVPlan({ snapshot: cutSnapshot(), report: reportFixture([]), now: NOW });
    expect([...new Set(plan.items.map((i) => i.entryId))]).toEqual(["e1", "e2", "e3", "e4"]);
    expect(plan.items.some((i) => i.entryId === "e5" || i.entryId === "e6")).toBe(false);
    // unselected entries become plan-level selection omissions (seeded at draft time)
    expect(plan.selectionOmissions).toEqual([
      { type: "experience", id: "e5", reason: "selection" },
      { type: "experience", id: "e6", reason: "selection" },
    ]);
  });

  it("scales the cut with the page budget (budget 1 → 2 kept, budget 3 → 5 kept)", () => {
    const snapshot = cutSnapshot();
    const b1 = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW, pageBudget: 1 });
    expect([...new Set(b1.items.map((i) => i.entryId))]).toEqual(["e1", "e2"]); // max(1, floor(4/2))
    expect(b1.selectionOmissions?.map((o) => o.id)).toEqual(["e3", "e4", "e5", "e6"]);

    const b3 = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW, pageBudget: 3 });
    expect([...new Set(b3.items.map((i) => i.entryId))]).toEqual(["e1", "e2", "e3", "e4", "e5"]); // cap + 1
    expect(b3.selectionOmissions?.map((o) => o.id)).toEqual(["e6"]);
  });

  it("records rank (1-based within the section before the cut), score, and the evidence basis per included entry", () => {
    const snapshot = cutSnapshot();
    const report = reportFixture([
      requirement({ id: "r1", text: "Alpha mandate", method: "exact", evidence: [ref("bullet", "b2")] }),
    ]);
    const plan = buildCVPlan({ snapshot, report, now: NOW });

    expect(SelectionRecordSchema.parse(plan.selection)).toBeDefined(); // payload conformance
    expect(plan.selection?.generatedAt).toBe(NOW.toISOString());
    // e2's exact-match evidence lifts it to rank 1; ranks are assigned BEFORE the cut
    expect(plan.selection?.included.map((e) => [e.entryId, e.rank])).toEqual([
      ["e2", 1],
      ["e1", 2],
      ["e3", 3],
      ["e4", 4],
    ]);
    const byEntry = new Map(plan.items.map((i) => [i.entryId, i]));
    for (const included of plan.selection?.included ?? []) {
      expect(included.kind).toBe("experience");
      expect(included.score).toBe(byEntry.get(included.entryId)!.entryScore); // the plan's unit score
    }
    const e2 = plan.selection?.included[0];
    if (!e2) throw new Error("expected the top-ranked entry in the selection record");
    expect(e2.basis.evidenceRefs).toEqual([ref("bullet", "b2")]); // MatchReport citations resolving into the snapshot
    expect(e2.basis.methodCredits).toEqual(["exact"]); // distinct match methods among the citations
    expect(e2.basis.recency).toBeCloseTo(recencyScore("2025-06", NOW), 6); // the plan's recency component
    // an included entry without citations carries an empty basis
    const e1 = plan.selection?.included[1];
    if (!e1) throw new Error("expected the second-ranked entry in the selection record");
    expect(e1.basis.evidenceRefs).toEqual([]);
    expect(e1.basis.methodCredits).toEqual([]);
    expect(e1.basis.recency).toBe(1); // present
  });

  it("caps every section at budget 2 (projects 2 / education 3 / certifications 3) with snapshot-order tie-breaking", () => {
    const snapshot = snapshotFixture({
      experience: [],
      projects: [1, 2, 3, 4, 5].map((i) => ({
        id: `p${i}`,
        name: `Project ${i}`,
        description: null,
        startDate: null,
        endDate: "2024-01",
        bullets: [bullet({ id: `pb${i}`, text: `Project bullet ${i}` })],
      })),
      education: [1, 2, 3, 4].map((i) => ({
        id: `ed${i}`,
        institution: `School ${i}`,
        degree: "BSc",
        field: null,
        startDate: null,
        endDate: "2016-05",
      })),
      certifications: [1, 2, 3, 4].map((i) => ({
        id: `c${i}`,
        title: `Cert ${i}`,
        issuer: "CNCF",
        issueDate: "2023-04",
      })),
    });
    const plan = buildCVPlan({ snapshot, report: reportFixture([]), now: NOW });
    // identical scores tie-break deterministically by snapshot order (SC-002)
    expect(plan.selectionOmissions).toEqual([
      { type: "project", id: "p3", reason: "selection" },
      { type: "project", id: "p4", reason: "selection" },
      { type: "project", id: "p5", reason: "selection" },
      { type: "education", id: "ed4", reason: "selection" },
      { type: "certification", id: "c4", reason: "selection" },
    ]);
    expect(plan.selection?.included.map((e) => [e.kind, e.entryId, e.rank])).toEqual([
      ["project", "p1", 1],
      ["project", "p2", 2],
      ["education", "ed1", 1],
      ["education", "ed2", 2],
      ["education", "ed3", 3],
      ["certification", "c1", 1],
      ["certification", "c2", 2],
      ["certification", "c3", 3],
    ]);
  });

  it("restored must-include entries are always drafted, do NOT consume a cap slot, and record their true rank", () => {
    const plan = buildCVPlan({
      snapshot: cutSnapshot(),
      report: reportFixture([]),
      restoredOmissions: [{ type: "experience", id: "e6", reason: "selection", restoredMustInclude: true }],
      now: NOW,
    });
    expect([...new Set(plan.items.map((i) => i.entryId))]).toEqual(["e1", "e2", "e3", "e4", "e6"]); // 4 cap slots + restored e6
    expect(plan.selectionOmissions).toEqual([{ type: "experience", id: "e5", reason: "selection" }]);
    expect(plan.mustIncludeKeys).toEqual([experienceClaimId("e6", 1), titleClaimId("e6")]); // both items of the restored entry
    const e6 = plan.selection?.included.find((e) => e.entryId === "e6");
    expect(e6).toMatchObject({ kind: "experience", rank: 6 }); // true rank within the section before the cut
  });

  it("a restored bullet-level omission protects its whole entry from the cut", () => {
    const plan = buildCVPlan({
      snapshot: cutSnapshot(),
      report: reportFixture([]),
      restoredOmissions: [
        { type: "experience_bullet", id: experienceClaimId("e6", 1), reason: "page_budget", restoredMustInclude: true },
      ],
      now: NOW,
    });
    expect([...new Set(plan.items.map((i) => i.entryId))]).toEqual(["e1", "e2", "e3", "e4", "e6"]);
    expect(plan.selectionOmissions?.map((o) => o.id)).toEqual(["e5"]);
  });

  it("is deterministic: identical inputs yield identical items, omissions, and SelectionRecord (SC-002)", () => {
    const snapshot = cutSnapshot();
    const report = reportFixture([
      requirement({ id: "r1", text: "Alpha mandate", method: "exact", evidence: [ref("bullet", "b2")] }),
    ]);
    const args = { snapshot, report, restoredOmissions: [], now: NOW };
    const a = buildCVPlan(args);
    const b = buildCVPlan(args);
    expect(a.items).toEqual(b.items);
    expect(a.selectionOmissions).toEqual(b.selectionOmissions);
    expect(a.selection).toEqual(b.selection); // includes generatedAt (fixed now) — byte-identical
  });
});

// --- summaryRequirements (feature 005 US3: JD must-haves feed the summary) ---

describe("buildCVPlan summaryRequirements (US3)", () => {
  it("collects the report's must-have requirement texts (top 5, report order stable)", () => {
    const snapshot = snapshotFixture({
      experience: [experience({ id: "e1", bullets: [bullet({ id: "b1", text: "Shipped module one" })] })],
    });
    const report = reportFixture([
      requirement({ id: "r-nice-1", text: "Nice to have one", importance: "nice" }),
      requirement({ id: "r-must-1", text: "Kubernetes in production", importance: "must" }),
      requirement({ id: "r-nice-2", text: "Nice to have two", importance: "nice" }),
      requirement({ id: "r-must-2", text: "Team leadership", importance: "must" }),
      requirement({ id: "r-must-3", text: "Go development", importance: "must" }),
      requirement({ id: "r-must-4", text: "Distributed systems", importance: "must" }),
      requirement({ id: "r-must-5", text: "Observability", importance: "must" }),
      requirement({ id: "r-must-6", text: "Sixth must-have beyond the cap", importance: "must" }),
    ]);

    const plan = buildCVPlan({ snapshot, report, now: NOW });
    // must-haves only, report order preserved, capped at 5 (US3 contract)
    expect(plan.summaryRequirements).toEqual([
      "Kubernetes in production",
      "Team leadership",
      "Go development",
      "Distributed systems",
      "Observability",
    ]);
  });

  it("is empty when the report has no must-have requirements", () => {
    const snapshot = snapshotFixture({
      experience: [experience({ id: "e1", bullets: [bullet({ id: "b1", text: "Shipped module one" })] })],
    });
    const report = reportFixture([
      requirement({ id: "r1", text: "Nice to have", importance: "nice" }),
      requirement({ id: "r2", text: "A gap", status: "gap", method: "none" }),
    ]);
    const plan = buildCVPlan({ snapshot, report, now: NOW });
    expect(plan.summaryRequirements).toEqual([]);
  });
});
