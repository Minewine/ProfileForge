import { beforeEach, describe, expect, it, vi } from "vitest";
import { PinnedSnapshotSchema, type PinnedSnapshot } from "@/lib/generation/plan";
import type { MatchReport } from "@/lib/jobs/schemas";
import { claimFingerprint, type GeneratedCVContent, type GenerationSettings } from "@/lib/generation/schemas";

vi.mock("@/lib/llm/router", () => ({
  callLLM: vi.fn(),
  registerTask: vi.fn(),
  resetTaskRegistry: vi.fn(),
  OPENROUTER_URL: "x",
}));

// --- Fixtures (plain data — the deterministic layer runs with zero AI) ---

function snapshotFixture(overrides: Partial<PinnedSnapshot> = {}): PinnedSnapshot {
  return PinnedSnapshotSchema.parse({
    id: "p1",
    version: 3,
    language: "en",
    experience: [
      {
        id: "e1",
        company: "Acme",
        title: "Platform Engineer",
        location: null,
        startDate: "2021-01",
        endDate: "present",
        skillsUsed: [],
        bullets: [
          { id: "b1", text: "Operated Kubernetes clusters serving 2M requests per day.", confidence: 0.9, containmentOk: true },
          { id: "b2", text: "Led a team of 5 engineers.", confidence: 0.8, containmentOk: true },
        ],
      },
    ],
    education: [{ id: "ed1", institution: "McGill University", degree: "BSc", field: "Computer Science", startDate: null, endDate: null }],
    skills: [{ id: "s1", name: "Kubernetes" }],
    languages: [],
    projects: [],
    certifications: [],
    ...overrides,
  });
}

function contentFixture(overrides: Partial<GeneratedCVContent> = {}): GeneratedCVContent {
  return {
    claimIdVersion: 1,
    summary: "Platform engineer with Kubernetes operations depth.",
    summaryProvenance: [{ type: "bullet", id: "b1", snippet: "Operated Kubernetes clusters serving 2M requests per day." }],
    experience: [
      {
        id: "e1",
        bullets: [
          { claimId: "exp.e1.1", text: "Operated Kubernetes clusters serving 2M requests per day.", sourceBulletIds: ["b1"] },
          { claimId: "exp.e1.2", text: "Led a team of 5 engineers.", sourceBulletIds: ["b2"] },
        ],
      },
    ],
    education: [],
    projects: [],
    certifications: [],
    skills: ["Kubernetes"],
    omissions: [],
    ...overrides,
  };
}

function reportFixture(overrides: Partial<MatchReport> = {}): MatchReport {
  return {
    overallScore: 60,
    scoreBreakdown: {
      hardRequirementsMet: 1,
      preferredRequirementsMet: 0,
      exactMatches: 1,
      aliasMatches: 0,
      semanticMatches: 0,
      hardWeight: 60,
      preferredWeight: 30,
      evidenceBonus: 0,
    },
    requirements: [
      {
        id: "r1",
        text: "Kubernetes",
        importance: "must",
        isHardConstraint: true,
        status: "strong",
        matchMethod: "exact",
        evidence: [{ type: "skill", id: "s1", snippet: "Kubernetes" }],
        note: null,
      },
      {
        id: "r2",
        text: "K8s orchestration at scale",
        importance: "nice",
        isHardConstraint: false,
        status: "strong",
        matchMethod: "approved_alias",
        evidence: [{ type: "skill", id: "s1", snippet: "Kubernetes" }],
        note: null,
      },
    ],
    recommendedKeywords: [],
    missingKeywords: [],
    semanticDropped: 0,
    ...overrides,
  };
}

const SETTINGS: GenerationSettings = { outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 60 };

function okLLM(data: unknown) {
  return { data, usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 }, modelUsed: "test/economy" };
}

const noCancel = vi.fn().mockResolvedValue(undefined);

beforeEach(async () => {
  vi.mocked((await import("@/lib/llm/router")).callLLM).mockReset();
});

// --- numericTokens: identical rule for FR and EN (FR-015 numeric identity) ---

describe("numericTokens", () => {
  it("extracts numbers, years, percentages, and durations identically for FR and EN", async () => {
    const { numericTokens } = await import("@/lib/generation/factguard");
    expect(numericTokens("Serving 2M requests per day, uptime 99.9% since 2021-06.")).toEqual([
      "2m",
      "99",
      "9",
      "2021",
      "06",
    ]);
    // French decimals, percentages, and years normalize under the same rule
    expect(numericTokens("Disponibilité de 99,9 % depuis juin 2021 pour 2M requêtes.")).toEqual([
      "99",
      "9",
      "2021",
      "2m",
    ]);
    expect(numericTokens("Led a team of 5 engineers for 3 years")).toEqual(["5", "3"]);
    expect(numericTokens("Encadra une equipe de 5 ingenieurs pendant 3 ans")).toEqual(["5", "3"]);
    expect(numericTokens("No digits here")).toEqual([]);
  });

  it("is the deterministic identity check behind NUMERIC_MISMATCH", async () => {
    const { numericTokens } = await import("@/lib/generation/factguard");
    const claim = numericTokens("Scaled the platform to 3M requests per day.");
    const evidence = new Set(numericTokens("Operated Kubernetes clusters serving 2M requests per day."));
    expect(claim.some((token) => !evidence.has(token))).toBe(true); // 3m is invented
    const honest = numericTokens("Serving 2M requests per day.");
    expect(honest.some((token) => !evidence.has(token))).toBe(false);
    expect(numericTokens).toBeDefined();
  });
});

// --- collectCVClaims: evidence resolution against the pinned snapshot ---

describe("collectCVClaims", () => {
  it("resolves cited evidence into texts and reports dangling ids", async () => {
    const { collectCVClaims } = await import("@/lib/generation/factguard");
    const snapshot = snapshotFixture();
    const content = contentFixture({
      experience: [
        {
          id: "e1",
          bullets: [
            { claimId: "exp.e1.1", text: "Ghost bullet.", sourceBulletIds: ["missing-1", "b1"] },
          ],
        },
      ],
    });
    const claims = collectCVClaims(content, snapshot);
    const ghost = claims.find((c) => c.claimId === "exp.e1.1")!;
    expect(ghost.danglingIds).toEqual(["missing-1"]);
    expect(ghost.evidenceTexts).toEqual(["Operated Kubernetes clusters serving 2M requests per day."]);
    const summary = claims.find((c) => c.claimId === "summary")!;
    expect(summary.evidenceIds).toEqual(["b1"]);
  });
});

// --- runFactGuard: one case per code (LETTER_DUPLICATES_CV arrives with US6) ---

async function guard(
  content: GeneratedCVContent,
  options: {
    snapshot?: PinnedSnapshot;
    matchReport?: MatchReport;
    verdicts?: Array<{ claimId: string; verdict: string; note?: string }>;
    draftWarnings?: Array<{ code: string; claim: string; severity?: string; resolution?: string }>;
    confirmedFingerprints?: Array<{ fingerprint: string; confirmedAt: string }>;
  } = {},
) {
  const { runFactGuard } = await import("@/lib/generation/factguard");
  const { callLLM } = await import("@/lib/llm/router");
  vi.mocked(callLLM).mockResolvedValue(okLLM({ verdicts: options.verdicts ?? [] }) as never);
  return runFactGuard({
    userId: "u-test",
    content,
    snapshot: options.snapshot ?? snapshotFixture(),
    matchReport: options.matchReport ?? reportFixture(),
    settings: SETTINGS,
    runId: "run-test",
    checkCancelled: noCancel,
    ...(options.draftWarnings ? { draftWarnings: options.draftWarnings as never[] } : {}),
    ...(options.confirmedFingerprints ? { confirmedFingerprints: options.confirmedFingerprints } : {}),
  });
}

describe("runFactGuard — deterministic layer codes", () => {
  it("DANGLING_PROVENANCE: cited ids that do not resolve in the pinned snapshot (and no resolvable provenance also raises UNSUPPORTED_CLAIM)", async () => {
    const report = await guard(
      contentFixture({
        experience: [
          { id: "e1", bullets: [{ claimId: "exp.e1.1", text: "Scaled clusters to 2M requests.", sourceBulletIds: ["ghost-1"] }] },
          { id: "e9", bullets: [{ claimId: "exp.e9.1", text: "Led a team of 5 engineers.", sourceBulletIds: ["b2"] }] },
        ],
      }),
      { verdicts: [{ claimId: "summary", verdict: "supported" }, { claimId: "exp.e9.1", verdict: "supported" }] },
    );
    expect(report.layersRun).toEqual({ deterministic: true, semantic: true });
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "DANGLING_PROVENANCE", claim: "exp.e1.1", severity: "blocker", resolution: "pending" }),
    );
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_CLAIM", claim: "exp.e1.1", severity: "blocker" }),
    );
    expect(report.summary.blockers).toBe(2);
  });

  it("UNSUPPORTED_CLAIM: material claim with empty provenance", async () => {
    const report = await guard(
      contentFixture({
        experience: [
          { id: "e1", bullets: [{ claimId: "exp.e1.1", text: "Invented achievement with no provenance.", sourceBulletIds: [] }] },
          { id: "e9", bullets: [{ claimId: "exp.e9.1", text: "Led a team of 5 engineers.", sourceBulletIds: ["b2"] }] },
        ],
      }),
      { verdicts: [{ claimId: "summary", verdict: "supported" }, { claimId: "exp.e9.1", verdict: "supported" }] },
    );
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_CLAIM", claim: "exp.e1.1", severity: "blocker" }),
    );
    expect(report.flags).not.toContainEqual(expect.objectContaining({ code: "DANGLING_PROVENANCE" }));
  });

  it("NUMERIC_MISMATCH (EN): a number absent from the cited evidence blocks; identical numbers pass", async () => {
    const bad = await guard(
      contentFixture({
        experience: [
          { id: "e1", bullets: [{ claimId: "exp.e1.1", text: "Operated Kubernetes clusters serving 3M requests per day.", sourceBulletIds: ["b1"] }] },
        ],
      }),
      { verdicts: [{ claimId: "summary", verdict: "supported" }, { claimId: "exp.e1.1", verdict: "supported" }] },
    );
    expect(bad.flags).toContainEqual(
      expect.objectContaining({ code: "NUMERIC_MISMATCH", claim: "exp.e1.1", severity: "blocker" }),
    );

    const good = await guard(contentFixture(), {
      verdicts: [
        { claimId: "summary", verdict: "supported" },
        { claimId: "exp.e1.1", verdict: "supported" },
        { claimId: "exp.e1.2", verdict: "supported" },
      ],
    });
    expect(good.flags.filter((f) => f.severity === "blocker")).toEqual([]);
    expect(good.summary).toEqual({ blockers: 0, warnings: 0 });
  });

  it("NUMERIC_MISMATCH (FR): the same normalization rule covers French decimals, percentages, and durations", async () => {
    const snapshot = snapshotFixture({
      experience: [
        {
          id: "e1",
          company: "Acme",
          title: "Ingénieur plateforme",
          location: null,
          startDate: "2019-01",
          endDate: "present",
          skillsUsed: [],
          bullets: [
            { id: "b1", text: "Réduction des coûts d'infrastructure de 14 % sur 3 ans pour 2M requêtes.", confidence: 0.9, containmentOk: true },
          ],
        },
      ],
    });
    const content = contentFixture({
      summary: "Ingénieur plateforme spécialisé Kubernetes.",
      summaryProvenance: [{ type: "bullet", id: "b1", snippet: "Réduction des coûts" }],
      experience: [
        { id: "e1", bullets: [{ claimId: "exp.e1.1", text: "Réduit les coûts de 40 % sur 3 ans pour 2M requêtes.", sourceBulletIds: ["b1"] }] },
      ],
      skills: [],
    });
    const report = await guard(content, {
      snapshot,
      verdicts: [
        { claimId: "summary", verdict: "supported" },
        { claimId: "exp.e1.1", verdict: "supported" },
      ],
    });
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "NUMERIC_MISMATCH", claim: "exp.e1.1", severity: "blocker" }),
    );

    const honest = contentFixture({
      summary: "Ingénieur plateforme spécialisé Kubernetes.",
      summaryProvenance: [{ type: "bullet", id: "b1", snippet: "Réduction des coûts" }],
      experience: [
        { id: "e1", bullets: [{ claimId: "exp.e1.1", text: "Réduit les coûts de 14 % sur 3 ans pour 2M requêtes.", sourceBulletIds: ["b1"] }] },
      ],
      skills: [],
    });
    const ok = await guard(honest, {
      snapshot,
      verdicts: [
        { claimId: "summary", verdict: "supported" },
        { claimId: "exp.e1.1", verdict: "supported" },
      ],
    });
    expect(ok.flags.filter((f) => f.severity === "blocker")).toEqual([]);
  });

  it("SKILL_UNVERIFIED: neither a pinned-profile skill nor an exact/approved-alias match", async () => {
    const report = await guard(
      contentFixture({
        skills: ["Kubernetes", "K8s orchestration at scale", "Rust"],
      }),
      {
        verdicts: [
          { claimId: "summary", verdict: "supported" },
          { claimId: "exp.e1.1", verdict: "supported" },
          { claimId: "exp.e1.2", verdict: "supported" },
        ],
      },
    );
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "SKILL_UNVERIFIED", claim: "Rust", severity: "blocker", affectedFieldIds: ["skills"] }),
    );
    expect(report.flags.filter((f) => f.code === "SKILL_UNVERIFIED")).toHaveLength(1);
  });

  it("blank claims (empty summary) are never flagged — nothing claimed, nothing to support", async () => {
    const report = await guard(
      contentFixture({
        summary: "",
        summaryProvenance: [],
        experience: [],
        skills: [],
      }),
      { verdicts: [] },
    );
    expect(report.flags).toEqual([]);
  });
});

describe("runFactGuard — semantic layer", () => {
  it("MEANING_DRIFT: verdict drifted blocks the claim", async () => {
    const report = await guard(contentFixture(), {
      verdicts: [
        { claimId: "summary", verdict: "supported" },
        { claimId: "exp.e1.1", verdict: "drifted", note: "inflated scope" },
        { claimId: "exp.e1.2", verdict: "supported" },
      ],
    });
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "MEANING_DRIFT", claim: "exp.e1.1", severity: "blocker", resolution: "pending" }),
    );
  });

  it("missing verdict ⇒ conservative MEANING_DRIFT; verdicts for unknown claimIds are dropped", async () => {
    const report = await guard(contentFixture(), {
      verdicts: [
        { claimId: "summary", verdict: "supported" },
        { claimId: "totally-bogus", verdict: "unsupported" },
      ],
    });
    const drifts = report.flags.filter((f) => f.code === "MEANING_DRIFT");
    expect(drifts.map((f) => f.claim).sort()).toEqual(["exp.e1.1", "exp.e1.2"]); // no verdict ⇒ drifted
    expect(report.flags).not.toContainEqual(expect.objectContaining({ claim: "totally-bogus" }));
  });

  it("semantic verdict unsupported ⇒ UNSUPPORTED_CLAIM", async () => {
    const report = await guard(contentFixture(), {
      verdicts: [
        { claimId: "summary", verdict: "supported" },
        { claimId: "exp.e1.1", verdict: "unsupported", note: "nothing supports this" },
        { claimId: "exp.e1.2", verdict: "supported" },
      ],
    });
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_CLAIM", claim: "exp.e1.1", severity: "blocker" }),
    );
  });

  it("sends only judgeable claims (non-empty text, resolvable evidence) with the resolved evidenceText", async () => {
    const { runFactGuard } = await import("@/lib/generation/factguard");
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue(
      okLLM({ verdicts: [{ claimId: "exp.e1.1", verdict: "supported" }] }) as never,
    );
    await runFactGuard({
    userId: "u-test",
      content: contentFixture({
        summary: "",
        summaryProvenance: [],
        experience: [
          { id: "e1", bullets: [{ claimId: "exp.e1.1", text: "Operated Kubernetes clusters serving 2M requests per day.", sourceBulletIds: ["b1"] }] },
          { id: "e9", bullets: [{ claimId: "exp.e9.1", text: "Ghost claim.", sourceBulletIds: ["ghost"] }] },
        ],
      }),
      snapshot: snapshotFixture(),
      matchReport: reportFixture(),
      settings: SETTINGS,
      runId: "run-42",
      checkCancelled: noCancel,
    });
    expect(noCancel).toHaveBeenCalled();
    expect(vi.mocked(callLLM)).toHaveBeenCalledWith({
      userId: "u-test",
      task: "factGuard",
      runId: "run-42",
      payload: {
        outputLanguage: "en",
        claims: [
          {
            claimId: "exp.e1.1",
            text: "Operated Kubernetes clusters serving 2M requests per day.",
            evidenceText: ["Operated Kubernetes clusters serving 2M requests per day."],
          },
        ],
      },
    });
  });

  it("task failure ⇒ layersRun.semantic = false with deterministic flags kept (job must not fail, R8)", async () => {
    const { runFactGuard } = await import("@/lib/generation/factguard");
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockRejectedValue(new Error("economy model down") as never);
    const report = await runFactGuard({
    userId: "u-test",
      content: contentFixture({
        experience: [
          { id: "e1", bullets: [{ claimId: "exp.e1.1", text: "Operated clusters serving 3M requests per day.", sourceBulletIds: ["b1"] }] },
        ],
      }),
      snapshot: snapshotFixture(),
      matchReport: reportFixture(),
      settings: SETTINGS,
      runId: "run-x",
      checkCancelled: noCancel,
    });
    expect(report.layersRun).toEqual({ deterministic: true, semantic: false });
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "NUMERIC_MISMATCH", claim: "exp.e1.1", resolution: "pending" }),
    );
    expect(report.flags).not.toContainEqual(expect.objectContaining({ code: "MEANING_DRIFT" }));
  });

  it("unparsable task output is treated as an unavailable layer (defensive, fail-closed)", async () => {
    const { runFactGuard } = await import("@/lib/generation/factguard");
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockResolvedValue(okLLM({ summary: "garbage", items: [] }) as never);
    const report = await runFactGuard({
    userId: "u-test",
      content: contentFixture(),
      snapshot: snapshotFixture(),
      matchReport: reportFixture(),
      settings: SETTINGS,
      runId: "run-y",
      checkCancelled: noCancel,
    });
    expect(report.layersRun.semantic).toBe(false);
  });
});

describe("runFactGuard — warnings and fingerprints", () => {
  it("warnings never block: draft warnings land in the report without touching the gate", async () => {
    const { factGuardGate } = await import("@/lib/generation/factguard");
    const report = await guard(contentFixture(), {
      verdicts: [
        { claimId: "summary", verdict: "supported" },
        { claimId: "exp.e1.1", verdict: "supported" },
        { claimId: "exp.e1.2", verdict: "supported" },
      ],
      draftWarnings: [
        { code: "VERBATIM_FALLBACK", claim: "exp.e1.2", severity: "warning", resolution: "pending" },
        { code: "UNCERTAIN_TRANSLATION", claim: "summary", severity: "warning", resolution: "pending" },
      ],
    });
    expect(report.summary).toEqual({ blockers: 0, warnings: 2 });
    expect(factGuardGate(report)).toMatchObject({ open: true, reason: null });
  });

  it("fail-closed (FR-010): layersRun.semantic = false closes the gate even with zero flags", async () => {
    const { runFactGuard, factGuardGate } = await import("@/lib/generation/factguard");
    const { callLLM } = await import("@/lib/llm/router");
    vi.mocked(callLLM).mockRejectedValue(new Error("down") as never);
    const report = await runFactGuard({
    userId: "u-test",
      content: contentFixture({ experience: [], skills: [] }), // summary claim still judgeable
      snapshot: snapshotFixture(),
      matchReport: reportFixture(),
      settings: SETTINGS,
      runId: "run-z",
      checkCancelled: noCancel,
    });
    expect(report.flags).toEqual([]);
    expect(report.layersRun.semantic).toBe(false);
    const gate = factGuardGate(report);
    expect(gate.open).toBe(false);
    expect(gate.reason).toBe("FACTGUARD_UNAVAILABLE");
  });

  it("fingerprint auto-confirm: an identical prior confirmation resolves the claim's blockers (FR-009/R10)", async () => {
    const { factGuardGate } = await import("@/lib/generation/factguard");
    const text = "Operated Kubernetes clusters serving 3M requests per day.";
    const confirmedAt = "2026-10-01T12:00:00.000Z";
    const report = await guard(
      contentFixture({
        experience: [{ id: "e1", bullets: [{ claimId: "exp.e1.1", text, sourceBulletIds: ["b1"] }] }],
      }),
      {
        verdicts: [{ claimId: "summary", verdict: "supported" }, { claimId: "exp.e1.1", verdict: "supported" }],
        confirmedFingerprints: [{ fingerprint: claimFingerprint(text, ["b1"]), confirmedAt }],
      },
    );
    expect(report.flags).toContainEqual(
      expect.objectContaining({ code: "NUMERIC_MISMATCH", claim: "exp.e1.1", resolution: "user_confirmed", confirmedAt }),
    );
    expect(report.summary.blockers).toBe(0); // confirmed blockers are not pending
    expect(factGuardGate(report).open).toBe(true);
  });
});

describe("claim-resolution content ops", () => {
  it("setClaimText edits the addressed block; removeClaim drops it (entries without bullets disappear)", async () => {
    const { setClaimText, removeClaim, findClaimEvidence } = await import("@/lib/generation/factguard");
    const base = contentFixture({
      education: [{ id: "ed1", claimId: "edu.ed1", text: "BSc · Computer Science · McGill University", sourceIds: ["ed1"] }],
    });
    const edited = setClaimText(base, "exp.e1.1", "Operated clusters serving 2M requests per day.") as GeneratedCVContent | null;
    expect(edited!.experience[0]!.bullets[0]!.text).toBe("Operated clusters serving 2M requests per day.");
    expect((setClaimText(base, "summary", "New summary.") as GeneratedCVContent | null)!.summary).toBe("New summary.");
    expect((setClaimText(base, "edu.ed1", "BSc informatique") as GeneratedCVContent | null)!.education[0]!.text).toBe("BSc informatique");
    expect(setClaimText(base, "exp.nothing.9", "x")).toBeNull();

    const removed = removeClaim(base, "exp.e1.1") as GeneratedCVContent | null;
    expect(removed!.experience[0]!.bullets.map((b) => b.claimId)).toEqual(["exp.e1.2"]);
    expect((removeClaim(removed!, "exp.e1.2") as GeneratedCVContent | null)!.experience).toEqual([]); // empty entry dropped
    expect(removeClaim(base, "exp.nothing.9")).toBeNull();

    expect(findClaimEvidence(base, "exp.e1.2")).toEqual({
      text: "Led a team of 5 engineers.",
      evidenceIds: ["b2"],
    });
    expect(findClaimEvidence(base, "bogus")).toBeNull();
  });

  it("applyConfirmation flips pending flags to user_confirmed with attribution", async () => {
    const { applyConfirmation } = await import("@/lib/generation/factguard");
    const report = {
      layersRun: { deterministic: true as const, semantic: true },
      flags: [
        { code: "NUMERIC_MISMATCH", claim: "exp.e1.1", severity: "blocker" as const, resolution: "pending" as const },
        { code: "VERBATIM_FALLBACK", claim: "exp.e1.1", severity: "warning" as const, resolution: "pending" as const },
        { code: "NUMERIC_MISMATCH", claim: "exp.e1.2", severity: "blocker" as const, resolution: "pending" as const },
      ],
      summary: { blockers: 2, warnings: 1 },
    };
    const confirmedAt = "2026-10-02T08:30:00.000Z";
    const next = applyConfirmation(report, "exp.e1.1", confirmedAt);
    expect(next.flags[0]).toMatchObject({ claim: "exp.e1.1", resolution: "user_confirmed", confirmedAt });
    expect(next.flags[1]).toMatchObject({ claim: "exp.e1.1", resolution: "user_confirmed", confirmedAt });
    expect(next.flags[2]).toMatchObject({ claim: "exp.e1.2", resolution: "pending" });
    expect(next.summary).toEqual({ blockers: 1, warnings: 0 });
  });
});

// --- US2 (feature 005): title claims ---

describe("title claims (feature 005 US2)", () => {
  it("collects expTitle claims with the entry as evidence; numeric mismatch fires on an invented number", async () => {
    const { collectCVClaims, runDeterministicLayer } = await import("@/lib/generation/factguard");
    const withTitle = contentFixture({
      experience: [
        {
          id: "e1",
          title: { claimId: "expTitle.e1", text: "Platform Engineer — 5 years SRE", sourceTitle: "Platform Engineer" },
          bullets: [
            { claimId: "exp.e1.1", text: "Operated Kubernetes clusters serving 2M requests per day.", sourceBulletIds: ["b1"] },
          ],
        },
      ],
    });
    const snapshot = snapshotFixture();
    const claims = collectCVClaims(withTitle, snapshot);
    const titleClaim = claims.find((c) => c.claimId === "expTitle.e1");
    expect(titleClaim).toBeDefined();
    expect(titleClaim!.text).toBe("Platform Engineer — 5 years SRE");
    expect(titleClaim!.evidenceIds).toContain("e1");

    // "5 years" is absent from the entry's evidence ("Platform Engineer — Acme") → blocker
    const flags = runDeterministicLayer({ claims, skills: withTitle.skills, snapshot, matchReport: reportFixture() });
    expect(flags.some((f) => f.code === "NUMERIC_MISMATCH" && f.claim === "expTitle.e1")).toBe(true);

    // without the invented number the title passes the deterministic layer
    const clean = contentFixture({
      experience: [
        {
          id: "e1",
          title: { claimId: "expTitle.e1", text: "Platform Engineer — Kubernetes focus", sourceTitle: "Platform Engineer" },
          bullets: [{ claimId: "exp.e1.1", text: "Operated Kubernetes clusters serving 2M requests per day.", sourceBulletIds: ["b1"] }],
        },
      ],
    });
    const cleanFlags = runDeterministicLayer({
      claims: collectCVClaims(clean, snapshot),
      skills: clean.skills,
      snapshot,
      matchReport: reportFixture(),
    });
    expect(cleanFlags.filter((f) => f.claim === "expTitle.e1")).toHaveLength(0);
  });

  it("claim ops: setClaimText edits, removeClaim reverts to the verbatim source title, findClaimEvidence resolves", async () => {
    const { setClaimText, removeClaim, findClaimEvidence } = await import("@/lib/generation/factguard");
    const withTitle = contentFixture({
      experience: [
        {
          id: "e1",
          title: { claimId: "expTitle.e1", text: "Rewritten Title", sourceTitle: "Platform Engineer" },
          bullets: [{ claimId: "exp.e1.1", text: "Bullet.", sourceBulletIds: ["b1"] }],
        },
      ],
    });
    expect(findClaimEvidence(withTitle, "expTitle.e1")).toEqual({ text: "Rewritten Title", evidenceIds: ["e1"] });
    const edited = setClaimText(withTitle, "expTitle.e1", "Edited Title") as GeneratedCVContent | null;
    expect(edited!.experience[0]!.title!.text).toBe("Edited Title");

    // DELETE reverts to the verbatim snapshot title — an entry is never title-less
    const removed = removeClaim(withTitle, "expTitle.e1") as GeneratedCVContent | null;
    expect(removed!.experience[0]!.title!.text).toBe("Platform Engineer");
    expect(removed!.experience[0]!.title!.claimId).toBe("expTitle.e1");
    expect(removeClaim(withTitle, "expTitle.nope")).toBeNull();
  });
});
