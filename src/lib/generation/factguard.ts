import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { callLLM } from "@/lib/llm/router";
import { FactGuardOutputSchema, type FactGuardVerdict } from "@/lib/llm/tasks/factguard"; // self-registering (registry pattern)
import { checkContainment } from "@/lib/validation/sourceContainment";
import { MatchReportSchema, type MatchReport } from "@/lib/jobs/schemas";
import { currentCvTexts, loadPinnedSnapshot, resolveEvidenceRefs, type PinnedSnapshot } from "@/lib/generation/plan";
import {
  claimFingerprint,
  type ClaimFingerprint,
  type CoverLetterContent,
  type GeneratedCVContent,
  type GenerationSettings,
  type OutputLanguage,
  type ValidationFlag,
  type ValidationReport,
} from "@/lib/generation/schemas";
import { normalizeText } from "@/lib/text/normalize";

/**
 * Stage 4 — the Fact Guard (contracts/generation-pipeline.md §Fact Guard,
 * research R8): a deterministic layer that runs with zero AI (reference
 * resolution against the pinned snapshot, numeric/date/duration token identity,
 * skills verification) plus an economy-tier semantic layer judging meaning
 * preservation. Warnings never block; `layersRun.semantic = false` closes the
 * download gate regardless of flag counts (fail-closed, FR-010) while the job
 * itself still succeeds.
 */

// --- Claims: the drafted content blocks with their resolved evidence ---

export type DraftClaim = {
  claimId: string;
  text: string;
  evidenceIds: string[]; // cited provenance ids (sourceBulletIds / sourceIds / provenance ids)
  evidenceTexts: string[]; // resolved against the pinned snapshot (dangling ids dropped)
  danglingIds: string[]; // cited ids that do not resolve in the pinned snapshot
};

/** Full text per id-addressable snapshot entry (mirrors plan.ts's evidence index). */
function snapshotTextIndex(snapshot: PinnedSnapshot): Map<string, string> {
  const pairs: Array<[string, string]> = [
    ...snapshot.skills.map((s) => [s.id, s.name] as [string, string]),
    ...snapshot.languages.map((l) => [l.id, l.name] as [string, string]),
    ...snapshot.certifications.map((c) => [c.id, [c.title, c.issuer].filter(Boolean).join(" · ")] as [string, string]),
    ...snapshot.education.map((e) => [e.id, [e.degree, e.field, e.institution].filter(Boolean).join(" · ")] as [string, string]),
    ...snapshot.experience.flatMap((e) => [
      ...e.bullets.map((b) => [b.id, b.text] as [string, string]),
      [e.id, `${e.title} — ${e.company}`] as [string, string],
    ]),
    ...snapshot.projects.flatMap((p) => [
      ...p.bullets.map((b) => [b.id, b.text] as [string, string]),
      [p.id, p.name] as [string, string],
    ]),
  ];
  return new Map(pairs);
}

/** Flatten the CV content into per-claim rows with evidence resolved against the
 *  pinned snapshot — the single input both layers and the fingerprints share. */
export function collectCVClaims(content: GeneratedCVContent, snapshot: PinnedSnapshot): DraftClaim[] {
  const index = snapshotTextIndex(snapshot);
  const build = (claimId: string, text: string, evidenceIds: string[]): DraftClaim => {
    const evidenceTexts: string[] = [];
    const danglingIds: string[] = [];
    for (const id of evidenceIds) {
      const resolved = index.get(id);
      if (resolved === undefined) danglingIds.push(id);
      else if (!evidenceTexts.includes(resolved)) evidenceTexts.push(resolved);
    }
    return { claimId, text, evidenceIds, evidenceTexts, danglingIds };
  };

  const claims: DraftClaim[] = [build("summary", content.summary, content.summaryProvenance.map((e) => e.id))];
  for (const entry of content.experience) {
    // feature 005 US2: the rewritten role title is a claim whose provenance is
    // the entry itself (the snapshot evidence index maps entry ids)
    if (entry.title) claims.push(build(entry.title.claimId, entry.title.text, [entry.id]));
    for (const bullet of entry.bullets) claims.push(build(bullet.claimId, bullet.text, bullet.sourceBulletIds));
  }
  for (const project of content.projects) {
    for (const bullet of project.bullets) claims.push(build(bullet.claimId, bullet.text, bullet.sourceBulletIds));
  }
  for (const edu of content.education) claims.push(build(edu.claimId, edu.text, edu.sourceIds));
  for (const cert of content.certifications) claims.push(build(cert.claimId, cert.text, cert.sourceIds));
  return claims;
}

/** Letter variant (US6): each paragraph is a claim whose evidence refs come from
 *  the plan (resolved against the pinned snapshot by the draft merge). */
export function collectLetterClaims(content: CoverLetterContent, snapshot: PinnedSnapshot): DraftClaim[] {
  const index = snapshotTextIndex(snapshot);
  return content.paragraphs.map((paragraph) => {
    const evidenceTexts: string[] = [];
    const danglingIds: string[] = [];
    for (const ref of paragraph.evidence) {
      const resolved = index.get(ref.id);
      if (resolved === undefined) danglingIds.push(ref.id);
      else if (!evidenceTexts.includes(resolved)) evidenceTexts.push(resolved);
    }
    return {
      claimId: paragraph.claimId,
      text: paragraph.text,
      evidenceIds: paragraph.evidence.map((e) => e.id),
      evidenceTexts,
      danglingIds,
    };
  });
}

// --- Complementarity (US6: LETTER_DUPLICATES_CV, deterministic) ---

/** A letter paragraph that reaches ≥0.95 normalized word containment against a
 *  current-CV bullet or the CV summary verbatim-reuses the CV — a blocker
 *  (FR-016, SC-008). Topical overlap is fine; only near-verbatim reuse flags. */
export function checkLetterComplementarity(
  paragraphs: Array<{ claimId: string; text: string }>,
  cvTexts: string[],
): ValidationFlag[] {
  const flags: ValidationFlag[] = [];
  for (const paragraph of paragraphs) {
    for (const cvText of cvTexts) {
      if (checkContainment(cvText, paragraph.text).ok) {
        flags.push({
          code: "LETTER_DUPLICATES_CV",
          claim: paragraph.claimId,
          severity: "blocker",
          resolution: "pending",
        });
        break; // one flag per duplicating paragraph
      }
    }
  }
  return flags;
}

// --- Numeric identity (identical rule for FR/EN — normalizeText is language-agnostic) ---

/** Tokens containing digits (numbers, years, percentages, durations) after
 *  normalizeText — "2M", "99,9 %", "5 ans", and "5 years" all reduce to plain
 *  digit tokens, so the comparison cannot diverge between languages. */
export function numericTokens(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((token) => /\d/.test(token));
}

// --- Deterministic layer (zero AI, always runs — FR-008) ---

export function runDeterministicLayer(args: {
  claims: DraftClaim[];
  skills: string[];
  snapshot: PinnedSnapshot;
  matchReport: MatchReport;
}): ValidationFlag[] {
  const flags: ValidationFlag[] = [];
  const blocker = (code: string, claim: string, extra?: Partial<ValidationFlag>) =>
    flags.push({ code, claim, severity: "blocker", resolution: "pending", ...extra });

  for (const claim of args.claims) {
    if (!claim.text.trim()) continue; // nothing claimed → nothing to support
    if (claim.danglingIds.length > 0) blocker("DANGLING_PROVENANCE", claim.claimId);
    if (claim.evidenceTexts.length === 0) {
      // no cited provenance at all, or none of it resolvable in the pinned snapshot
      blocker("UNSUPPORTED_CLAIM", claim.claimId);
    } else {
      const evidence = new Set(claim.evidenceTexts.flatMap((text) => numericTokens(text)));
      const invented = numericTokens(claim.text).filter((token) => !evidence.has(token));
      if (invented.length > 0) blocker("NUMERIC_MISMATCH", claim.claimId);
    }
  }

  const profileSkills = new Set([...args.snapshot.skills, ...args.snapshot.languages].map((s) => normalizeText(s.name)));
  const matchedRequirementTexts = new Set(
    args.matchReport.requirements
      .filter((r) => (r.matchMethod === "exact" || r.matchMethod === "approved_alias") && r.status !== "gap")
      .map((r) => normalizeText(r.text)),
  );
  for (const skill of args.skills) {
    const normalized = normalizeText(skill);
    if (!normalized) continue;
    if (!profileSkills.has(normalized) && !matchedRequirementTexts.has(normalized)) {
      blocker("SKILL_UNVERIFIED", skill, { affectedFieldIds: ["skills"] });
    }
  }
  return flags;
}

// --- Semantic layer (economy tier; failure ⇒ fail-closed, never a job failure) ---

export type FactGuardVerdictMap = Map<string, FactGuardVerdict>;

/** Judge meaning preservation via the economy task. Returns null when the layer
 *  is unavailable (call failure or unusable output) or when nothing is judgeable
 *  — both mean "semantic did not run" (`layersRun.semantic = false`, FR-010).
 *  Claims already flagged deterministically as unresolvable are not sent: they
 *  have no evidence text to judge against and their blockers already stand. */
export async function runSemanticLayer(args: {
  userId: string;
  claims: DraftClaim[];
  outputLanguage: OutputLanguage;
  runId: string;
  checkCancelled: () => Promise<void>;
}): Promise<FactGuardVerdictMap | null> {
  const judgeable = args.claims.filter((c) => c.text.trim().length > 0 && c.evidenceTexts.length > 0);
  if (judgeable.length === 0) return null;
  await args.checkCancelled(); // cancelRequested is checked before every LLM call
  let data: unknown;
  try {
    const result = await callLLM<unknown>({
      userId: args.userId,
      task: "factGuard",
      payload: {
        outputLanguage: args.outputLanguage,
        claims: judgeable.map((c) => ({ claimId: c.claimId, text: c.text, evidenceText: c.evidenceTexts })),
      },
      runId: args.runId,
    });
    data = result.data;
  } catch {
    return null; // outage ⇒ fail-closed gate, job continues (research R8)
  }
  const parsed = FactGuardOutputSchema.safeParse(data);
  if (!parsed.success) return null; // defensive: unusable output = unavailable layer

  const sent = new Set(judgeable.map((c) => c.claimId));
  const verdicts: FactGuardVerdictMap = new Map();
  for (const v of parsed.data.verdicts) {
    if (sent.has(v.claimId)) verdicts.set(v.claimId, v.verdict); // unknown claimIds dropped
  }
  for (const claim of judgeable) {
    if (!verdicts.has(claim.claimId)) verdicts.set(claim.claimId, "drifted"); // missing ⇒ conservative drift
  }
  return verdicts;
}

// --- Report assembly (flags + resolutions + summary) ---

function summarize(flags: ValidationFlag[]): { blockers: number; warnings: number } {
  return {
    blockers: flags.filter((f) => f.severity === "blocker" && f.resolution === "pending").length,
    warnings: flags.filter((f) => f.severity === "warning" && f.resolution === "pending").length,
  };
}

function assembleReport(args: {
  claims: DraftClaim[];
  semanticRan: boolean;
  verdicts: FactGuardVerdictMap | null;
  deterministicFlags: ValidationFlag[];
  draftWarnings: ValidationFlag[]; // VERBATIM_FALLBACK / UNCERTAIN_TRANSLATION (not re-derivable)
  confirmedFingerprints: ClaimFingerprint[];
  historyFlags?: ValidationFlag[]; // prior edited/removed flags kept as the audit trail
  confirmedResolutions?: Map<string, string>; // `${code}|${claim}` → confirmedAt from prior confirmations
}): ValidationReport {
  const fresh = [...args.deterministicFlags];
  const seen = new Set(fresh.map((f) => `${f.code}|${f.claim}`));
  if (args.verdicts) {
    for (const claim of args.claims) {
      if (!claim.text.trim()) continue;
      const verdict = args.verdicts.get(claim.claimId);
      if (!verdict || verdict === "supported") continue;
      const code = verdict === "drifted" ? "MEANING_DRIFT" : "UNSUPPORTED_CLAIM";
      const key = `${code}|${claim.claimId}`;
      if (!seen.has(key)) {
        fresh.push({ code, claim: claim.claimId, severity: "blocker", resolution: "pending" });
        seen.add(key);
      }
    }
  }

  // confirmation application (blockers only): prior per-flag confirmations and
  // identical fingerprints (R10) auto-resolve to user_confirmed
  const fingerprints = new Map(args.confirmedFingerprints.map((f) => [f.fingerprint, f.confirmedAt]));
  const claimById = new Map(args.claims.map((c) => [c.claimId, c]));
  const resolved = fresh.map((flag) => {
    if (flag.severity !== "blocker") return flag;
    const prior = args.confirmedResolutions?.get(`${flag.code}|${flag.claim}`);
    const claim = claimById.get(flag.claim);
    const fingerprintAt =
      prior ?? (claim ? fingerprints.get(claimFingerprint(claim.text, claim.evidenceIds)) : undefined);
    return fingerprintAt ? { ...flag, resolution: "user_confirmed" as const, confirmedAt: fingerprintAt } : flag;
  });

  const flags = [...(args.historyFlags ?? []), ...resolved, ...args.draftWarnings];
  return {
    layersRun: { deterministic: true, semantic: args.semanticRan },
    flags,
    summary: summarize(flags),
  };
}

// --- Pipeline entry (stage 4) ---

/** Run both Fact Guard layers over a freshly drafted version. Semantic-layer
 *  failure never throws — it produces `layersRun.semantic = false` so the job
 *  succeeds while the download gate stays closed (research R8). */
export async function runFactGuard(args: {
  userId: string;
  content: GeneratedCVContent;
  snapshot: PinnedSnapshot;
  matchReport: MatchReport;
  settings: GenerationSettings;
  runId: string;
  checkCancelled: () => Promise<void>;
  draftWarnings?: ValidationFlag[];
  confirmedFingerprints?: ClaimFingerprint[];
}): Promise<ValidationReport> {
  const claims = collectCVClaims(args.content, args.snapshot);
  const deterministicFlags = runDeterministicLayer({
    claims,
    skills: args.content.skills,
    snapshot: args.snapshot,
    matchReport: args.matchReport,
  });
  const verdicts = await runSemanticLayer({
    userId: args.userId,
    claims,
    outputLanguage: args.settings.outputLanguage,
    runId: args.runId,
    checkCancelled: args.checkCancelled,
  });
  return assembleReport({
    claims,
    semanticRan: verdicts !== null,
    verdicts,
    deterministicFlags,
    draftWarnings: args.draftWarnings ?? [],
    confirmedFingerprints: args.confirmedFingerprints ?? [],
  });
}

/** Letter variant of the pipeline Fact Guard (stage 4, US6): the same two
 *  layers over the letter's paragraphs plus the deterministic
 *  LETTER_DUPLICATES_CV complementarity check against the current CV texts
 *  (R11). Same fail-closed semantics as the CV guard. */
export async function runLetterFactGuard(args: {
  userId: string;
  content: CoverLetterContent;
  snapshot: PinnedSnapshot;
  cvTexts: string[];
  settings: GenerationSettings;
  runId: string;
  checkCancelled: () => Promise<void>;
  draftWarnings?: ValidationFlag[];
  confirmedFingerprints?: ClaimFingerprint[];
}): Promise<ValidationReport> {
  const claims = collectLetterClaims(args.content, args.snapshot);
  const deterministicFlags = [
    ...runDeterministicLayer({ claims, skills: [], snapshot: args.snapshot, matchReport: emptyReport() }),
    ...checkLetterComplementarity(
      args.content.paragraphs.map((p) => ({ claimId: p.claimId, text: p.text })),
      args.cvTexts,
    ),
  ];
  const verdicts = await runSemanticLayer({
    userId: args.userId,
    claims,
    outputLanguage: args.settings.outputLanguage,
    runId: args.runId,
    checkCancelled: args.checkCancelled,
  });
  return assembleReport({
    claims,
    semanticRan: verdicts !== null,
    verdicts,
    deterministicFlags,
    draftWarnings: args.draftWarnings ?? [],
    confirmedFingerprints: args.confirmedFingerprints ?? [],
  });
}

/** An empty report shell — the letter path runs the skills check with no skills
 *  and needs no MatchReport, but runDeterministicLayer's shape requires one. */
function emptyReport(): MatchReport {
  return {
    overallScore: 0,
    scoreBreakdown: {
      hardRequirementsMet: 0,
      preferredRequirementsMet: 0,
      exactMatches: 0,
      aliasMatches: 0,
      semanticMatches: 0,
    },
    requirements: [],
    recommendedKeywords: [],
    missingKeywords: [],
  } as unknown as MatchReport;
}

// --- Claim-edit re-validation (PATCH/DELETE routes, R10) ---

/** Re-run both Fact Guard layers over an edited/removed version's content.
 *  Prior flags for the addressed claim become the audit trail (`edited` /
 *  `removed`); pending blockers on unchanged claims are re-derived (passing
 *  flags clear, failing flags stay pending); confirmations survive via prior
 *  resolutions and identical fingerprints. `semanticAvailable = false` means
 *  the semantic layer could not run — the caller returns 409
 *  FACTGUARD_UNAVAILABLE while keeping the stored edit. */
export async function revalidateVersionClaims(args: {
  userId: string;
  analysisId: string;
  profileVersion: number;
  settings: GenerationSettings;
  content: GeneratedCVContent | CoverLetterContent; // already edited / claim already removed
  priorReport: ValidationReport;
  editedClaimId?: string;
  removedClaimId?: string;
  confirmedFingerprints: ClaimFingerprint[];
}): Promise<{ report: ValidationReport; semanticAvailable: boolean }> {
  const snapshot = await loadPinnedSnapshot(args.userId, args.profileVersion);
  const analysis = await db.jobAnalysis.findUnique({ where: { id: args.analysisId } });
  if (!analysis || analysis.matchReport == null) {
    throw new ApiError(
      "GENERATION_INVALID_STATE",
      "The analysis no longer has a stored match report — claims cannot be re-validated.",
    );
  }
  const matchReport = resolveEvidenceRefs(MatchReportSchema.parse(analysis.matchReport), snapshot).report;

  // Letters are recognized by shape (their claims routes may not know the kind).
  const content = args.content;
  const isLetter = "paragraphs" in content;
  const claims = isLetter ? collectLetterClaims(content, snapshot) : collectCVClaims(content, snapshot);
  const deterministicFlags = isLetter
    ? [
        ...runDeterministicLayer({ claims, skills: [], snapshot, matchReport: emptyReport() }),
        ...checkLetterComplementarity(
          content.paragraphs.map((p) => ({ claimId: p.claimId, text: p.text })),
          // complementarity is judged against the CURRENT CV, not the analysis —
          // load it the same way the pipeline's plan stage does
          await currentCvTexts(args.analysisId),
        ),
      ]
    : runDeterministicLayer({
        claims,
        skills: content.skills,
        snapshot,
        matchReport,
      });
  const verdicts = await runSemanticLayer({
    userId: args.userId,
    claims,
    outputLanguage: args.settings.outputLanguage,
    runId: `reval-${args.analysisId}-${Date.now()}`, // fresh cost-cap scope per re-validation
    checkCancelled: async () => {}, // the owning job is terminal; cancellation does not apply
  });

  const addressed = args.editedClaimId ?? args.removedClaimId ?? null;
  const addressedResolution = args.editedClaimId ? ("edited" as const) : ("removed" as const);
  const historyFlags: ValidationFlag[] = [];
  const confirmedResolutions = new Map<string, string>();
  const carriedWarnings: ValidationFlag[] = [];
  for (const flag of args.priorReport.flags) {
    if (flag.resolution === "edited" || flag.resolution === "removed") {
      historyFlags.push(flag); // audit trail stays
    } else if (addressed !== null && flag.claim === addressed) {
      historyFlags.push({ ...flag, resolution: addressedResolution, confirmedAt: undefined });
    } else if (flag.resolution === "user_confirmed" && flag.confirmedAt && flag.severity === "blocker") {
      confirmedResolutions.set(`${flag.code}|${flag.claim}`, flag.confirmedAt);
      // re-derived below: kept as user_confirmed when the flag still fires
    } else if (flag.severity === "warning") {
      carriedWarnings.push(flag); // warnings are not re-derivable — carried as-is
    }
    // pending blockers on unchanged claims are re-derived by the fresh run above
  }

  const report = assembleReport({
    claims,
    semanticRan: verdicts !== null,
    verdicts,
    deterministicFlags,
    draftWarnings: carriedWarnings,
    confirmedFingerprints: args.confirmedFingerprints,
    historyFlags,
    confirmedResolutions,
  });
  return { report, semanticAvailable: verdicts !== null };
}

// --- Download-gate predicate (fail-closed, FR-010 / data-model gate matrix) ---

export function pendingBlockers(report: ValidationReport): ValidationFlag[] {
  return report.flags.filter((f) => f.severity === "blocker" && f.resolution === "pending");
}

export type FactGuardGate = {
  open: boolean;
  reason: null | "FACTGUARD_UNAVAILABLE" | "BLOCKERS_UNRESOLVED";
  pendingBlockers: ValidationFlag[];
};

/** The Fact Guard half of the download gate: semantic must have run (fail-closed
 *  even with zero flags), then no pending blockers may remain. */
export function factGuardGate(report: ValidationReport): FactGuardGate {
  if (!report.layersRun.semantic) {
    return { open: false, reason: "FACTGUARD_UNAVAILABLE", pendingBlockers: pendingBlockers(report) };
  }
  const pending = pendingBlockers(report);
  if (pending.length > 0) return { open: false, reason: "BLOCKERS_UNRESOLVED", pendingBlockers: pending };
  return { open: true, reason: null, pendingBlockers: [] };
}

// --- Claim-resolution content operations (structured content, never artifacts) ---

/** Locate a claim's text and cited evidence ids in the content; null when unknown. */
export function findClaimEvidence(
  content: GeneratedCVContent | CoverLetterContent,
  claimId: string,
): { text: string; evidenceIds: string[] } | null {
  if ("paragraphs" in content) {
    const paragraph = content.paragraphs.find((p) => p.claimId === claimId);
    return paragraph ? { text: paragraph.text, evidenceIds: paragraph.evidence.map((e) => e.id) } : null;
  }
  if (claimId.startsWith("expTitle.")) {
    const entry = content.experience.find((e) => e.title?.claimId === claimId);
    return entry?.title ? { text: entry.title.text, evidenceIds: [entry.id] } : null;
  }
  if (claimId === "summary") {
    return { text: content.summary, evidenceIds: content.summaryProvenance.map((e) => e.id) };
  }
  for (const entry of content.experience) {
    const bullet = entry.bullets.find((b) => b.claimId === claimId);
    if (bullet) return { text: bullet.text, evidenceIds: bullet.sourceBulletIds };
  }
  for (const project of content.projects) {
    const bullet = project.bullets.find((b) => b.claimId === claimId);
    if (bullet) return { text: bullet.text, evidenceIds: bullet.sourceBulletIds };
  }
  const edu = content.education.find((e) => e.claimId === claimId);
  if (edu) return { text: edu.text, evidenceIds: edu.sourceIds };
  const cert = content.certifications.find((c) => c.claimId === claimId);
  if (cert) return { text: cert.text, evidenceIds: cert.sourceIds };
  return null;
}

/** Replace a claim's text; returns a new content object, or null when the
 *  claimId addresses nothing in this version. */
export function setClaimText(
  content: GeneratedCVContent | CoverLetterContent,
  claimId: string,
  text: string,
): GeneratedCVContent | CoverLetterContent | null {
  if (findClaimEvidence(content, claimId) === null) return null;
  if ("paragraphs" in content) {
    return {
      ...content,
      paragraphs: content.paragraphs.map((p) => (p.claimId === claimId ? { ...p, text } : p)),
    };
  }
  if (claimId.startsWith("expTitle.")) {
    return {
      ...content,
      experience: content.experience.map((e) =>
        e.title?.claimId === claimId ? { ...e, title: { ...e.title, text } } : e,
      ),
    };
  }
  const mapBullet = <B extends { claimId: string; text: string }>(bullet: B): B =>
    bullet.claimId === claimId ? { ...bullet, text } : bullet;
  return {
    ...content,
    ...(claimId === "summary" ? { summary: text } : {}),
    experience: content.experience.map((entry) => ({ ...entry, bullets: entry.bullets.map(mapBullet) })),
    projects: content.projects.map((project) => ({ ...project, bullets: project.bullets.map(mapBullet) })),
    education: content.education.map((e) => (e.claimId === claimId ? { ...e, text } : e)),
    certifications: content.certifications.map((c) => (c.claimId === claimId ? { ...c, text } : c)),
  };
}

/** Remove a claim block from the content (entries left without bullets are
 *  dropped — no empty sections); null when the claimId addresses nothing. */
export function removeClaim(
  content: GeneratedCVContent | CoverLetterContent,
  claimId: string,
): GeneratedCVContent | CoverLetterContent | null {
  if ("paragraphs" in content) {
    if (!content.paragraphs.some((p) => p.claimId === claimId)) return null;
    return { ...content, paragraphs: content.paragraphs.filter((p) => p.claimId !== claimId) };
  }
  if (claimId.startsWith("expTitle.")) {
    if (!content.experience.some((e) => e.title?.claimId === claimId)) return null;
    return {
      ...content,
      // DELETE reverts to the verbatim snapshot title — an entry is never title-less
      experience: content.experience.map((e) =>
        e.title?.claimId === claimId ? { ...e, title: { ...e.title, text: e.title.sourceTitle } } : e,
      ),
    };
  }
  if (claimId === "summary") {
    return { ...content, summary: "", summaryProvenance: [] };
  }
  if (findClaimEvidence(content, claimId) === null) return null;
  const experience = content.experience
    .map((entry) => ({ ...entry, bullets: entry.bullets.filter((b) => b.claimId !== claimId) }))
    .filter((entry) => entry.bullets.length > 0);
  const projects = content.projects
    .map((project) => ({ ...project, bullets: project.bullets.filter((b) => b.claimId !== claimId) }))
    .filter((project) => project.bullets.length > 0);
  const education = content.education.filter((e) => e.claimId !== claimId);
  const certifications = content.certifications.filter((c) => c.claimId !== claimId);
  return { ...content, experience, projects, education, certifications };
}

/** Confirm-route flag surgery: pending flags for the claim become user_confirmed
 *  with the attribution timestamp; the summary recomputes (pending counts only). */
export function applyConfirmation(report: ValidationReport, claimId: string, confirmedAt: string): ValidationReport {
  const flags = report.flags.map((f) =>
    f.claim === claimId && f.resolution === "pending"
      ? { ...f, resolution: "user_confirmed" as const, confirmedAt }
      : f,
  );
  return { ...report, flags, summary: summarize(flags) };
}
