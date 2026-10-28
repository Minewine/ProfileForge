import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { getOrCreateProfile, getProfile } from "@/lib/profile/repository";
import {
  MatchReportSchema,
  type EvidenceRef,
  type MatchReport,
  type RequirementMatch,
} from "@/lib/jobs/schemas";
import { getLatestSuccessfulVersion } from "@/lib/generation/repository";
import {
  DEFAULT_CV_PAGE_BUDGET,
  GeneratedCVContentSchema,
  certificationClaimId,
  educationClaimId,
  experienceClaimId,
  letterClaimId,
  projectClaimId,
  titleClaimId,
  type Omission,
  type SelectionEntryKind,
  type SelectionRecord,
} from "@/lib/generation/schemas";
import { normalizeText } from "@/lib/text/normalize";
import type { StageContext } from "@/lib/generation/pipeline";

/**
 * Pipeline stages 1–2 (contracts/generation-pipeline.md): pin the profile
 * snapshot at the job's `profileVersion`, resolve MatchReport evidence refs
 * against it (dangling → skipped + `stale-analysis` notice, research R5), then
 * build the fully deterministic content plan (R7) — ranking, skills list,
 * must-include set. Pure scoring below; the stage runners carry the I/O.
 */

// --- Pinned snapshot (ProfileSnapshot.data = serializeProfile output) ---

const SnapshotBulletSchema = z.object({
  id: z.string(),
  text: z.string(),
  confidence: z.number().nullish(),
  containmentOk: z.boolean().nullish(),
});
export type SnapshotBullet = z.infer<typeof SnapshotBulletSchema>;

const SnapshotExperienceSchema = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(), // YYYY-MM | "present" | null (null = present)
  skillsUsed: z.array(z.string()).catch([]),
  bullets: z.array(SnapshotBulletSchema).catch([]),
});
export type SnapshotExperience = z.infer<typeof SnapshotExperienceSchema>;

const SnapshotProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  bullets: z.array(SnapshotBulletSchema).catch([]),
});
export type SnapshotProject = z.infer<typeof SnapshotProjectSchema>;

const SnapshotEducationSchema = z.object({
  id: z.string(),
  institution: z.string(),
  degree: z.string().nullish(),
  field: z.string().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});
export type SnapshotEducation = z.infer<typeof SnapshotEducationSchema>;

const SnapshotCertificationSchema = z.object({
  id: z.string(),
  title: z.string(),
  issuer: z.string().nullish(),
  issueDate: z.string().nullish(), // YYYY-MM
});
export type SnapshotCertification = z.infer<typeof SnapshotCertificationSchema>;

const SnapshotSkillSchema = z.object({ id: z.string(), name: z.string() });
/** Languages carry a proficiency level (rendered by the designed sidebar). */
const SnapshotLanguageSchema = z.object({
  id: z.string(),
  name: z.string(),
  proficiency: z.string().nullish(),
});

export const PinnedSnapshotSchema = z.object({
  id: z.string(),
  version: z.number(),
  language: z.string(),
  basics: z.unknown().optional(),
  experience: z.array(SnapshotExperienceSchema).catch([]),
  education: z.array(SnapshotEducationSchema).catch([]),
  skills: z.array(SnapshotSkillSchema).catch([]),
  languages: z.array(SnapshotLanguageSchema).catch([]),
  projects: z.array(SnapshotProjectSchema).catch([]),
  certifications: z.array(SnapshotCertificationSchema).catch([]),
});
export type PinnedSnapshot = z.infer<typeof PinnedSnapshotSchema>;

/** EvidenceRef view of every id-addressable snapshot entry (mirrors the
 *  matching engine's buildEvidenceIndex, over the pinned snapshot). */
function snapshotEvidenceIndex(snapshot: PinnedSnapshot): Map<string, EvidenceRef> {
  const ref = (type: EvidenceRef["type"], id: string, snippet: string) => ({
    type,
    id,
    snippet: snippet.slice(0, 200),
  });
  const pairs: Array<readonly [string, EvidenceRef]> = [
    ...snapshot.skills.map((s) => [s.id, ref("skill", s.id, s.name)] as const),
    ...snapshot.languages.map((l) => [l.id, ref("skill", l.id, l.name)] as const),
    ...snapshot.certifications.map((c) => [
      c.id,
      ref("certification", c.id, [c.title, c.issuer].filter(Boolean).join(" · ")),
    ] as const),
    ...snapshot.education.map((e) => [
      e.id,
      ref("education", e.id, [e.degree, e.field, e.institution].filter(Boolean).join(" · ")),
    ] as const),
    ...snapshot.experience.flatMap((e) => [
      ...e.bullets.map((b) => [b.id, ref("bullet", b.id, b.text)] as const),
      [e.id, ref("bullet", e.id, `${e.title} — ${e.company}`)] as const,
    ]),
    ...snapshot.projects.flatMap((p) => [
      ...p.bullets.map((b) => [b.id, ref("bullet", b.id, b.text)] as const),
      [p.id, ref("bullet", p.id, p.name)] as const,
    ]),
  ];
  return new Map(pairs);
}

// --- Evidence resolution (research R5) ---

/** Prune MatchReport evidence refs that dangle against the pinned snapshot.
 *  Dangling refs are skipped — never fabricated, never fatal; the caller stores
 *  the `stale-analysis` notice so the user knows a re-match would help. */
export function resolveEvidenceRefs(
  report: MatchReport,
  snapshot: PinnedSnapshot,
): { report: MatchReport; dangling: EvidenceRef[] } {
  const index = snapshotEvidenceIndex(snapshot);
  const dangling: EvidenceRef[] = [];
  const seen = new Set<string>();
  const requirements = report.requirements.map((r) => {
    const evidence = r.evidence.filter((e) => {
      if (index.has(e.id)) return true;
      const key = `${e.type}:${e.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        dangling.push(e);
      }
      return false;
    });
    return evidence.length === r.evidence.length ? r : { ...r, evidence };
  });
  return { report: { ...report, requirements }, dangling };
}

// --- Ranking (contracts/generation-pipeline.md stage 2 — weights v1, tunable) ---

export const RANKING_WEIGHTS = { relevance: 0.45, strength: 0.25, impact: 0.15, recency: 0.15 } as const;
/** MatchMethod credit for MatchReport evidence links (w1 sub-weights). */
export const METHOD_WEIGHTS = { exact: 1.0, approved_alias: 0.9, semantic: 0.7 } as const;
export const RELEVANCE_WEIGHTS = { evidence: 0.7, keywordOverlap: 0.3 } as const;
export const STRENGTH_CONSTANTS = {
  evidenceRefCap: 3,
  evidenceRefsWeight: 0.5,
  confidenceWeight: 0.3,
  containmentWeight: 0.2,
  defaultConfidence: 0.5,
} as const;
/** Linear recency decay reaches 0 at this many years past the entry's end. */
export const RECENCY_DECAY_YEARS = 15;

/** recency = 1 − years/15 (clamped to [0,1]); "present"/null end dates are current ⇒ 1.0. */
export function recencyScore(endDate: string | null | undefined, now: Date): number {
  if (!endDate || endDate === "present") return 1;
  const end = Date.parse(`${endDate}-01T00:00:00Z`);
  if (Number.isNaN(end)) return 0;
  const years = (now.getTime() - end) / (365.25 * 24 * 3600 * 1000);
  return Math.max(0, Math.min(1, 1 - years / RECENCY_DECAY_YEARS));
}

/** Keyword pool for the w2 overlap signal: all requirement texts ∪ recommendedKeywords. */
function keywordSet(report: MatchReport): string[] {
  const keywords = new Set<string>();
  for (const r of report.requirements) {
    const n = normalizeText(r.text);
    if (n) keywords.add(n);
  }
  for (const k of report.recommendedKeywords) {
    const n = normalizeText(k);
    if (n) keywords.add(n);
  }
  return [...keywords];
}

/** Share of each keyword's words present in the unit text, averaged over the pool. */
function keywordOverlap(unitText: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const words = new Set(normalizeText(unitText).split(" ").filter(Boolean));
  let sum = 0;
  for (const keyword of keywords) {
    const kwWords = keyword.split(" ").filter(Boolean);
    if (kwWords.length === 0) continue;
    sum += kwWords.filter((w) => words.has(w)).length / kwWords.length;
  }
  return sum / keywords.length;
}

/** impact = presence of quantified outcomes: digits cover numbers, years,
 *  percentages, and durations ("5 years", "30%", "2M") in one deterministic test. */
function impactScore(text: string): number {
  return /\d/.test(text) ? 1 : 0;
}

function scoreUnit(
  unit: {
    text: string;
    refCount: number;
    methodWeight: number;
    confidence: number; // already defaulted
    containment: number; // 0..1 share
    endDate: string | null | undefined;
  },
  keywords: string[],
  now: Date,
): number {
  const relevance =
    RELEVANCE_WEIGHTS.evidence * unit.methodWeight +
    RELEVANCE_WEIGHTS.keywordOverlap * keywordOverlap(unit.text, keywords);
  const strength =
    STRENGTH_CONSTANTS.evidenceRefsWeight *
      (Math.min(unit.refCount, STRENGTH_CONSTANTS.evidenceRefCap) / STRENGTH_CONSTANTS.evidenceRefCap) +
    STRENGTH_CONSTANTS.confidenceWeight * unit.confidence +
    STRENGTH_CONSTANTS.containmentWeight * unit.containment;
  const impact = impactScore(unit.text);
  const recency = recencyScore(unit.endDate, now);
  return (
    RANKING_WEIGHTS.relevance * relevance +
    RANKING_WEIGHTS.strength * strength +
    RANKING_WEIGHTS.impact * impact +
    RANKING_WEIGHTS.recency * recency
  );
}

/** Per-entry signals from the (already resolved) report: how many matched
 *  requirements cite the id, and the best method weight among them. */
function unitSignals(report: MatchReport): Map<string, { refCount: number; methodWeight: number }> {
  const signals = new Map<string, { refCount: number; methodWeight: number }>();
  for (const r of report.requirements) {
    if (r.status === "gap") continue; // gaps carry no evidence credit
    const weight =
      r.matchMethod in METHOD_WEIGHTS ? METHOD_WEIGHTS[r.matchMethod as keyof typeof METHOD_WEIGHTS] : 0;
    for (const e of r.evidence) {
      const current = signals.get(e.id) ?? { refCount: 0, methodWeight: 0 };
      current.refCount += 1;
      current.methodWeight = Math.max(current.methodWeight, weight);
      signals.set(e.id, current);
    }
  }
  return signals;
}

/** A ranked unit's signal: evidence citations of the entry id itself plus those
 *  of its bullets — ref counts summed, method credit is the best among them. */
function aggregateSignal(
  signals: Map<string, { refCount: number; methodWeight: number }>,
  ids: string[],
): { refCount: number; methodWeight: number } {
  let refCount = 0;
  let methodWeight = 0;
  for (const id of ids) {
    const s = signals.get(id);
    if (!s) continue;
    refCount += s.refCount;
    methodWeight = Math.max(methodWeight, s.methodWeight);
  }
  return { refCount, methodWeight };
}

/** Requirement citations per entry id (audit trail on plan items). */
function evidenceByEntryId(report: MatchReport): Map<string, EvidenceRef[]> {
  const map = new Map<string, EvidenceRef[]>();
  for (const r of report.requirements) {
    for (const e of r.evidence) {
      const list = map.get(e.id) ?? [];
      list.push(e);
      map.set(e.id, list);
    }
  }
  return map;
}

// --- Deterministic skills list (R7: exact/approved-alias only, JD terminology) ---

/** Skills section entries: requirements matched exactly or via approved alias
 *  whose skill evidence still resolves in the pinned snapshot — rendered as the
 *  JD requirement text, ordered by importance (must first), then match credit. */
export function buildSkillsList(report: MatchReport, snapshot: PinnedSnapshot): string[] {
  const skillIds = new Set([...snapshot.skills.map((s) => s.id), ...snapshot.languages.map((l) => l.id)]);
  const importanceRank = (r: RequirementMatch) => (r.importance === "must" ? 0 : 1);
  const credit = (r: RequirementMatch) =>
    r.matchMethod in METHOD_WEIGHTS ? METHOD_WEIGHTS[r.matchMethod as keyof typeof METHOD_WEIGHTS] : 0;

  const qualified = report.requirements
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.matchMethod === "exact" || r.matchMethod === "approved_alias")
    .filter(({ r }) => r.status !== "gap")
    .filter(({ r }) => r.evidence.some((e) => e.type === "skill" && skillIds.has(e.id)))
    .sort((a, b) => importanceRank(a.r) - importanceRank(b.r) || credit(b.r) - credit(a.r) || a.index - b.index);

  const skills: string[] = [];
  const seen = new Set<string>();
  for (const { r } of qualified) {
    const normalized = normalizeText(r.text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    skills.push(r.text);
  }
  return skills;
}

// --- Selection cut (feature 005, contracts/selection-rewriting.md) ---

/** Per-section entry caps at the default page budget 2 (tunable constants v1):
 *  experience 4 / projects 2 / education 3 / certifications 3. */
export const SELECTION_CAPS: Record<SelectionEntryKind, number> = {
  experience: 4,
  project: 2,
  education: 3,
  certification: 3,
};

/** Budget scaling (contracts/selection-rewriting.md): budget 1 →
 *  max(1, floor(cap/2)); budget 2 → cap; budget 3 → cap + 1. */
export function selectionCap(kind: SelectionEntryKind, pageBudget: number): number {
  const cap = SELECTION_CAPS[kind];
  if (pageBudget <= 1) return Math.max(1, Math.floor(cap / 2));
  if (pageBudget >= 3) return cap + 1;
  return cap;
}

/** Restored omissions (must-include) are always drafted and never consume a cap
 *  slot; a restored entry id, bullet id, or claim key protects its whole entry. */
function entryIsRestored(restoredIds: Set<string>, entryId: string, protectedIds: string[]): boolean {
  return restoredIds.has(entryId) || protectedIds.some((id) => restoredIds.has(id));
}

/** Deterministic cut of one ranked section: keep the top-`cap` non-restored
 *  entries in rank order (ties already broken by snapshot order upstream) plus
 *  every restored entry regardless of rank. */
function cutRankedSection<T>(ranked: T[], cap: number, isRestored: (item: T) => boolean): { kept: T[]; cut: T[] } {
  const kept: T[] = [];
  const cut: T[] = [];
  let slots = cap;
  for (const item of ranked) {
    if (isRestored(item)) {
      kept.push(item);
      continue;
    }
    if (slots > 0) {
      kept.push(item);
      slots -= 1;
    } else {
      cut.push(item);
    }
  }
  return { kept, cut };
}

/** MatchReport citations of the given snapshot ids, deduplicated, in id order. */
function citationsFor(citations: Map<string, EvidenceRef[]>, ids: string[]): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const e of citations.get(id) ?? []) {
      const key = `${e.type}:${e.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(e);
      }
    }
  }
  return refs;
}

/** Distinct match methods among the citations of the given ids, in
 *  METHOD_WEIGHTS order (exact / approved_alias / semantic). */
function methodCreditsFor(methodsById: Map<string, Set<string>>, ids: string[]): string[] {
  const present = new Set<string>();
  for (const id of ids) {
    for (const m of methodsById.get(id) ?? []) present.add(m);
  }
  return Object.keys(METHOD_WEIGHTS).filter((m) => present.has(m));
}

/** Requirement match methods per cited evidence id (non-gap requirements with a
 *  credited matchMethod only — mirrors unitSignals' gap/none exclusions). */
function methodsByEvidenceId(report: MatchReport): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const r of report.requirements) {
    if (r.status === "gap") continue;
    if (!(r.matchMethod in METHOD_WEIGHTS)) continue;
    for (const e of r.evidence) {
      const set = map.get(e.id) ?? new Set<string>();
      set.add(r.matchMethod);
      map.set(e.id, set);
    }
  }
  return map;
}

// --- Content plan ---

export type CVPlanItem = {
  key: string; // stable claim id (exp.{id}.{n} / proj.{id}.{n} / edu.{id} / cert.{id} / expTitle.{id})
  kind: "experience" | "project" | "education" | "certification" | "title";
  entryId: string; // owning pinned-snapshot entry id
  sourceText: string[]; // verbatim pinned-snapshot text
  sourceIds: string[]; // provenance ids resolving into the pinned snapshot
  entryMeta: { title: string; company: string; dates: string };
  evidence: EvidenceRef[]; // MatchReport citations of this item (audit only)
  score: number; // item-level score
  entryScore: number; // owning entry's unit score (whole-entry-before-bullet demotion, US3)
  mustInclude: boolean; // restored omissions are exempt from demotion (US5)
};

export type CVPlan = {
  kind: "cv";
  items: CVPlanItem[]; // deterministic order: experience, projects, education, certifications
  skills: string[]; // deterministic from the MatchReport (R7)
  summarySources: string[]; // top-scored bullet texts feeding the LLM summary
  summaryEvidence: EvidenceRef[]; // → content.summaryProvenance
  /** JD must-have requirement texts (top ≤5, report order) the summary must
   *  foreground (feature 005 US3) — different reports ⇒ different summaries. */
  summaryRequirements: string[];
  jdDigest: { role: string | null; keywords: string[] };
  mustIncludeKeys: string[];
  /** Restored skill omissions (US5) — exempt from the fit loop's Tier-3 skill
   *  demotion, so a restored skill is never silently re-omitted (SC-006). */
  mustIncludeSkills?: string[];
  /** SelectionRecord built by the same cut (feature 005) — the plan stage puts
   *  it on StageContext.selection for the persist stage; absent on hand-built
   *  plans (tests). */
  selection?: SelectionRecord;
  /** Whole entries NOT selected by the cut — seeded into content.omissions at
   *  draft time (before the fit loop) so the omissions list is complete by
   *  construction (FR-008); the fit loop only ever APPENDS page_budget ones. */
  selectionOmissions?: Omission[];
};

/** Top-N bullet items feeding the summary draft and its provenance. */
export const SUMMARY_SOURCE_LIMIT = 5;

/** Top-N must-have requirement texts the summary must connect evidence to (US3). */
export const SUMMARY_REQUIREMENTS_LIMIT = 5;

function dateRange(start: string | null | undefined, end: string | null | undefined): string {
  return [start ?? "", end ?? ""].filter(Boolean).join(" – ");
}

/**
 * Build the deterministic CV content plan. Experience entries and projects rank
 * as units (bullets inside follow their own scores — whole-entry-before-bullet
 * ordering); education and certifications rank individually. After ranking, the
 * feature-005 selection cut applies the per-section caps (budget-scaled) with
 * deterministic tie-breaking; restored omissions are always drafted. All inputs
 * are plain data, so the same inputs always yield the same plan (SC-002).
 */
export function buildCVPlan(args: {
  snapshot: PinnedSnapshot;
  report: MatchReport; // evidence already resolved against the snapshot (stage 1)
  restoredOmissions?: Omission[];
  now?: Date;
  /** Page budget scaling the per-section caps (default: the documented 2). */
  pageBudget?: number;
}): CVPlan {
  const now = args.now ?? new Date();
  const pageBudget = args.pageBudget ?? DEFAULT_CV_PAGE_BUDGET;
  const keywords = keywordSet(args.report);
  const signals = unitSignals(args.report);
  const citations = evidenceByEntryId(args.report);
  const methodsById = methodsByEvidenceId(args.report);
  const signal = (id: string) => signals.get(id) ?? { refCount: 0, methodWeight: 0 };

  // restored omissions (US5) are must-include: matched by claim key, source id, or entry id
  const restored = (args.restoredOmissions ?? []).filter((o) => o.restoredMustInclude === true);
  const restoredIds = new Set(restored.map((o) => o.id));

  const rankedExperience = [...args.snapshot.experience]
    .map((entry, index) => {
      const entryText = [entry.title, entry.company, ...entry.skillsUsed, ...entry.bullets.map((b) => b.text)]
        .filter(Boolean)
        .join(" ");
      const s = aggregateSignal(signals, [entry.id, ...entry.bullets.map((b) => b.id)]);
      const entryScore = scoreUnit(
        {
          text: entryText,
          refCount: s.refCount,
          methodWeight: s.methodWeight,
          confidence: entry.bullets.length
            ? entry.bullets.reduce((acc, b) => acc + (b.confidence ?? STRENGTH_CONSTANTS.defaultConfidence), 0) /
              entry.bullets.length
            : STRENGTH_CONSTANTS.defaultConfidence,
          containment: entry.bullets.length
            ? entry.bullets.filter((b) => b.containmentOk === true).length / entry.bullets.length
            : 0,
          endDate: entry.endDate,
        },
        keywords,
        now,
      );
      const rankedBullets = entry.bullets
        .map((b) => {
          const bs = signal(b.id);
          return {
            bullet: b,
            score: scoreUnit(
              {
                text: b.text,
                refCount: bs.refCount,
                methodWeight: bs.methodWeight,
                confidence: b.confidence ?? STRENGTH_CONSTANTS.defaultConfidence,
                containment: b.containmentOk === true ? 1 : 0,
                endDate: entry.endDate,
              },
              keywords,
              now,
            ),
          };
        })
        .sort((a, b) => b.score - a.score); // stable sort keeps snapshot order on ties

      return { entry, entryScore, rankedBullets, index };
    })
    .sort((a, b) => b.entryScore - a.entryScore); // stable — snapshot order breaks ties (SC-002)
  const experienceCut = cutRankedSection(
    rankedExperience,
    selectionCap("experience", pageBudget),
    (r) =>
      entryIsRestored(restoredIds, r.entry.id, [
        ...r.entry.bullets.map((b) => b.id),
        ...r.rankedBullets.map((_, i) => experienceClaimId(r.entry.id, i + 1)),
        titleClaimId(r.entry.id),
      ]),
  );
  const experienceRank = new Map(rankedExperience.map((r, i) => [r.entry.id, i + 1] as const));
  const experienceItems: CVPlanItem[] = experienceCut.kept.flatMap(({ entry, entryScore, rankedBullets }) => [
    ...rankedBullets.map((ranked, i) => ({
      key: experienceClaimId(entry.id, i + 1),
      kind: "experience" as const,
      entryId: entry.id,
      sourceText: [ranked.bullet.text],
      sourceIds: [ranked.bullet.id],
      entryMeta: { title: entry.title, company: entry.company, dates: dateRange(entry.startDate, entry.endDate) },
      evidence: citations.get(ranked.bullet.id) ?? [],
      score: ranked.score,
      entryScore,
      mustInclude: false,
    })),
    // feature 005 US2: the role title is a first-class rewrite target with its
    // own claim (expTitle.{id}); skipped by the model → verbatim fallback
    {
      key: titleClaimId(entry.id),
      kind: "title" as const,
      entryId: entry.id,
      sourceText: [entry.title],
      sourceIds: [entry.id],
      entryMeta: { title: entry.title, company: entry.company, dates: dateRange(entry.startDate, entry.endDate) },
      evidence: citationsFor(citations, [entry.id]),
      score: entryScore,
      entryScore,
      mustInclude: false,
    },
  ]);

  const rankedProjects = [...args.snapshot.projects]
    .map((project, index) => {
      const projectText = [project.name, project.description ?? "", ...project.bullets.map((b) => b.text)]
        .filter(Boolean)
        .join(" ");
      const s = aggregateSignal(signals, [project.id, ...project.bullets.map((b) => b.id)]);
      const entryScore = scoreUnit(
        {
          text: projectText,
          refCount: s.refCount,
          methodWeight: s.methodWeight,
          confidence: project.bullets.length
            ? project.bullets.reduce((acc, b) => acc + (b.confidence ?? STRENGTH_CONSTANTS.defaultConfidence), 0) /
              project.bullets.length
            : STRENGTH_CONSTANTS.defaultConfidence,
          containment: project.bullets.length
            ? project.bullets.filter((b) => b.containmentOk === true).length / project.bullets.length
            : 0,
          endDate: project.endDate,
        },
        keywords,
        now,
      );
      const rankedBullets = project.bullets
        .map((b) => {
          const bs = signal(b.id);
          return {
            bullet: b,
            score: scoreUnit(
              {
                text: b.text,
                refCount: bs.refCount,
                methodWeight: bs.methodWeight,
                confidence: b.confidence ?? STRENGTH_CONSTANTS.defaultConfidence,
                containment: b.containmentOk === true ? 1 : 0,
                endDate: project.endDate,
              },
              keywords,
              now,
            ),
          };
        })
        .sort((a, b) => b.score - a.score);
      return { project, entryScore, rankedBullets, index };
    })
    .sort((a, b) => b.entryScore - a.entryScore); // stable — snapshot order breaks ties (SC-002)
  const projectCut = cutRankedSection(
    rankedProjects,
    selectionCap("project", pageBudget),
    (r) =>
      entryIsRestored(restoredIds, r.project.id, [
        ...r.project.bullets.map((b) => b.id),
        ...r.rankedBullets.map((_, i) => projectClaimId(r.project.id, i + 1)),
      ]),
  );
  const projectRank = new Map(rankedProjects.map((r, i) => [r.project.id, i + 1] as const));
  const projectItems: CVPlanItem[] = projectCut.kept.flatMap(({ project, entryScore, rankedBullets }) =>
    rankedBullets.map((ranked, i) => ({
      key: projectClaimId(project.id, i + 1),
      kind: "project" as const,
      entryId: project.id,
      sourceText: [ranked.bullet.text],
      sourceIds: [ranked.bullet.id],
      entryMeta: { title: project.name, company: "", dates: dateRange(project.startDate, project.endDate) },
      evidence: citations.get(ranked.bullet.id) ?? [],
      score: ranked.score,
      entryScore,
      mustInclude: false,
    })),
  );

  const rankedEducation = args.snapshot.education
    .map((edu, index) => {
      const s = signal(edu.id);
      return {
        edu,
        index,
        score: scoreUnit(
          {
            text: [edu.degree, edu.field, edu.institution].filter(Boolean).join(" "),
            refCount: s.refCount,
            methodWeight: s.methodWeight,
            confidence: STRENGTH_CONSTANTS.defaultConfidence, // education rows carry no confidence
            containment: 0,
            endDate: edu.endDate,
          },
          keywords,
          now,
        ),
      };
    })
    .sort((a, b) => b.score - a.score); // stable — snapshot order breaks ties (SC-002)
  const educationCut = cutRankedSection(
    rankedEducation,
    selectionCap("education", pageBudget),
    (r) => entryIsRestored(restoredIds, r.edu.id, [educationClaimId(r.edu.id)]),
  );
  const educationRank = new Map(rankedEducation.map((r, i) => [r.edu.id, i + 1] as const));
  const educationItems: CVPlanItem[] = educationCut.kept.map(({ edu, score }) => ({
    key: educationClaimId(edu.id),
    kind: "education" as const,
    entryId: edu.id,
    sourceText: [edu.degree, edu.field, edu.institution].filter((t): t is string => Boolean(t)),
    sourceIds: [edu.id],
    entryMeta: {
      title: [edu.degree, edu.field].filter(Boolean).join(" ") || "Education",
      company: edu.institution,
      dates: dateRange(edu.startDate, edu.endDate),
    },
    evidence: citations.get(edu.id) ?? [],
    score,
    entryScore: score,
    mustInclude: false,
  }));

  const rankedCertifications = args.snapshot.certifications
    .map((cert, index) => {
      const s = signal(cert.id);
      return {
        cert,
        index,
        score: scoreUnit(
          {
            text: [cert.title, cert.issuer].filter(Boolean).join(" "),
            refCount: s.refCount,
            methodWeight: s.methodWeight,
            confidence: STRENGTH_CONSTANTS.defaultConfidence,
            containment: 0,
            endDate: cert.issueDate,
          },
          keywords,
          now,
        ),
      };
    })
    .sort((a, b) => b.score - a.score); // stable — snapshot order breaks ties (SC-002)
  const certificationCut = cutRankedSection(
    rankedCertifications,
    selectionCap("certification", pageBudget),
    (r) => entryIsRestored(restoredIds, r.cert.id, [certificationClaimId(r.cert.id)]),
  );
  const certificationRank = new Map(rankedCertifications.map((r, i) => [r.cert.id, i + 1] as const));
  const certificationItems: CVPlanItem[] = certificationCut.kept.map(({ cert, score }) => ({
    key: certificationClaimId(cert.id),
    kind: "certification" as const,
    entryId: cert.id,
    sourceText: [cert.title, cert.issuer].filter((t): t is string => Boolean(t)),
    sourceIds: [cert.id],
    entryMeta: { title: cert.title, company: cert.issuer ?? "", dates: cert.issueDate ?? "" },
    evidence: citations.get(cert.id) ?? [],
    score,
    entryScore: score,
    mustInclude: false,
  }));

  const items = [...experienceItems, ...projectItems, ...educationItems, ...certificationItems];

  // restored omissions (US5) are must-include: matched by claim key, source id, or entry id
  // (the cut above already kept their whole entries — this flag exempts them from demotion)
  for (const item of items) {
    item.mustInclude = restored.some(
      (o) => o.id === item.key || item.sourceIds.includes(o.id) || o.id === item.entryId,
    );
  }

  // summary sources: top-scored experience/project bullets, provenance resolving into the snapshot
  const index = snapshotEvidenceIndex(args.snapshot);
  // summary sources stay evidence bullets (parent contract) — title items are
  // rewrite targets, not summary fodder (feature 005 US2)
  const topBullets = [...experienceItems, ...projectItems]
    .filter((i) => i.kind !== "title")
    .sort((a, b) => b.score - a.score)
    .slice(0, SUMMARY_SOURCE_LIMIT);
  const summaryEvidence: EvidenceRef[] = [];
  const seenEvidence = new Set<string>();
  for (const item of topBullets) {
    for (const id of item.sourceIds) {
      const ref = index.get(id);
      if (ref && !seenEvidence.has(id)) {
        seenEvidence.add(id);
        summaryEvidence.push(ref);
      }
    }
  }

  // restored skill omissions join the must-include set by normalized skill text (US5)
  const skills = buildSkillsList(args.report, args.snapshot);
  const restoredIdsForSkills = new Set(restored.map((o) => normalizeText(o.id)));
  const mustIncludeSkills = skills.filter((s) => restoredIdsForSkills.has(normalizeText(s)));

  // SelectionRecord (feature 005): one entry per INCLUDED entry — rank 1-based
  // within its section BEFORE the cut, the plan's unit score, and the evidence
  // basis (MatchReport citations resolving into the snapshot, their distinct
  // match methods, the plan's recency component). Cut entries are NOT
  // duplicated here — they live in content.omissions with reason "selection"
  // (R1/R6). Section order and within-section rank order are deterministic.
  const selection: SelectionRecord = {
    included: [
      ...experienceCut.kept.map(({ entry, entryScore }) => {
        const basisIds = [entry.id, ...entry.bullets.map((b) => b.id)];
        return {
          entryId: entry.id,
          kind: "experience" as const,
          rank: experienceRank.get(entry.id)!,
          score: entryScore,
          basis: {
            evidenceRefs: citationsFor(citations, basisIds),
            methodCredits: methodCreditsFor(methodsById, basisIds),
            recency: recencyScore(entry.endDate, now),
          },
        };
      }),
      ...projectCut.kept.map(({ project, entryScore }) => {
        const basisIds = [project.id, ...project.bullets.map((b) => b.id)];
        return {
          entryId: project.id,
          kind: "project" as const,
          rank: projectRank.get(project.id)!,
          score: entryScore,
          basis: {
            evidenceRefs: citationsFor(citations, basisIds),
            methodCredits: methodCreditsFor(methodsById, basisIds),
            recency: recencyScore(project.endDate, now),
          },
        };
      }),
      ...educationCut.kept.map(({ edu, score }) => ({
        entryId: edu.id,
        kind: "education" as const,
        rank: educationRank.get(edu.id)!,
        score,
        basis: {
          evidenceRefs: citationsFor(citations, [edu.id]),
          methodCredits: methodCreditsFor(methodsById, [edu.id]),
          recency: recencyScore(edu.endDate, now),
        },
      })),
      ...certificationCut.kept.map(({ cert, score }) => ({
        entryId: cert.id,
        kind: "certification" as const,
        rank: certificationRank.get(cert.id)!,
        score,
        basis: {
          evidenceRefs: citationsFor(citations, [cert.id]),
          methodCredits: methodCreditsFor(methodsById, [cert.id]),
          recency: recencyScore(cert.issueDate, now),
        },
      })),
    ],
    generatedAt: now.toISOString(),
  };

  // unselected whole entries — seeded into the draft's omissions at draft time,
  // before the fit loop (which only ever APPENDS page_budget ones)
  const selectionOmissions: Omission[] = [
    ...experienceCut.cut.map(({ entry }): Omission => ({ type: "experience", id: entry.id, reason: "selection" })),
    ...projectCut.cut.map(({ project }): Omission => ({ type: "project", id: project.id, reason: "selection" })),
    ...educationCut.cut.map(({ edu }): Omission => ({ type: "education", id: edu.id, reason: "selection" })),
    ...certificationCut.cut.map(({ cert }): Omission => ({ type: "certification", id: cert.id, reason: "selection" })),
  ];

  return {
    kind: "cv",
    items,
    skills,
    summarySources: topBullets.map((i) => i.sourceText[0]).filter(Boolean),
    summaryEvidence,
    // US3: the finalized report's must-have texts, report order, capped at 5 —
    // the summary prompt connects strongest evidence to exactly these areas
    summaryRequirements: args.report.requirements
      .filter((r) => r.importance === "must")
      .slice(0, SUMMARY_REQUIREMENTS_LIMIT)
      .map((r) => r.text),
    jdDigest: { role: null, keywords: [...new Set(args.report.recommendedKeywords)] },
    mustIncludeKeys: items.filter((i) => i.mustInclude).map((i) => i.key),
    ...(mustIncludeSkills.length > 0 ? { mustIncludeSkills } : {}),
    selection,
    selectionOmissions,
  };
}

// --- Letter plan (US6, contracts/llm-tasks.md generateCoverLetter) ---

export const LETTER_MAX_WORDS = 320;
export type LetterAngle = "motivation" | "fit" | "achievement";

export type LetterPlanItem = {
  key: string; // letter.{n} — angle order is fixed: motivation, fit, achievement
  angle: LetterAngle;
  sourceText: string[]; // verbatim pinned-snapshot evidence texts
  evidence: EvidenceRef[]; // refs resolving into the pinned snapshot
  score: number; // demotion order for the 1-page fit loop (fit.ts)
};

export type LetterPlan = {
  kind: "letter";
  items: LetterPlanItem[];
  jdDigest: { role: string | null; keywords: string[]; topRequirements: string[] };
  maxWords: number;
};

/** Paragraph evidence per angle, all deterministic:
 *  - motivation — the most recent experience entry (its title/company ref + top bullet)
 *  - fit        — evidence refs of matched requirements (exact/alias/semantic, non-gap)
 *  - achievement — the top-scored experience/project bullets (same scoring as the CV plan)
 *  Angles with no evidence are skipped — the letter simply has fewer paragraphs. */
export function buildLetterPlan(args: {
  snapshot: PinnedSnapshot;
  report: MatchReport; // evidence already resolved against the snapshot (stage 1)
  now?: Date;
}): LetterPlan {
  const now = args.now ?? new Date();
  const keywords = keywordSet(args.report);
  const signals = unitSignals(args.report);
  const index = snapshotEvidenceIndex(args.snapshot);
  const signal = (id: string) => signals.get(id) ?? { refCount: 0, methodWeight: 0 };

  const refsFor = (ids: string[]): EvidenceRef[] => {
    const refs: EvidenceRef[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const ref = index.get(id);
      if (ref && !seen.has(id)) {
        seen.add(id);
        refs.push(ref);
      }
    }
    return refs;
  };

  // motivation: the most recent experience entry (recency of the end date)
  const motivationEntry = [...args.snapshot.experience]
    .map((entry) => ({ entry, recency: recencyScore(entry.endDate, now) }))
    .sort((a, b) => b.recency - a.recency)[0];
  const motivationSource = motivationEntry
    ? [
        `${motivationEntry.entry.title} — ${motivationEntry.entry.company}`,
        ...motivationEntry.entry.bullets.slice(0, 1).map((b) => b.text),
      ].filter(Boolean)
    : [];
  const motivationRefs = motivationEntry
    ? refsFor([motivationEntry.entry.id, ...motivationEntry.entry.bullets.slice(0, 1).map((b) => b.id)])
    : [];

  // fit: evidence refs of matched requirements (importance-ordered), capped
  const fitRequirementRefs = args.report.requirements
    .filter((r) => r.status !== "gap" && r.evidence.length > 0)
    .sort((a, b) => (a.importance === b.importance ? 0 : a.importance === "must" ? -1 : 1))
    .slice(0, 3)
    .flatMap((r) => r.evidence);
  const fitRefs = refsFor(fitRequirementRefs.map((e) => e.id));
  const fitSource = fitRefs.map((e) => e.snippet);

  // achievement: top-scored experience/project bullets (same scoring as the CV plan)
  const rankedBullets = [
    ...args.snapshot.experience.flatMap((entry) =>
      entry.bullets.map((b) => ({
        bullet: b,
        score: scoreUnit(
          {
            text: b.text,
            refCount: signal(b.id).refCount,
            methodWeight: signal(b.id).methodWeight,
            confidence: b.confidence ?? STRENGTH_CONSTANTS.defaultConfidence,
            containment: b.containmentOk === true ? 1 : 0,
            endDate: entry.endDate,
          },
          keywords,
          now,
        ),
      })),
    ),
    ...args.snapshot.projects.flatMap((project) =>
      project.bullets.map((b) => ({
        bullet: b,
        score: scoreUnit(
          {
            text: b.text,
            refCount: signal(b.id).refCount,
            methodWeight: signal(b.id).methodWeight,
            confidence: b.confidence ?? STRENGTH_CONSTANTS.defaultConfidence,
            containment: b.containmentOk === true ? 1 : 0,
            endDate: project.endDate,
          },
          keywords,
          now,
        ),
      })),
    ),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const achievementRefs = refsFor(rankedBullets.map((r) => r.bullet.id));
  const achievementSource = rankedBullets.map((r) => r.bullet.text);

  const allAngles: Array<{ angle: LetterAngle; sourceText: string[]; evidence: EvidenceRef[]; score: number }> = [
    // narrative order fixes the claim ids: motivation opens, achievement closes.
    // scores drive demotion (fit.ts) — the motivation paragraph drops first
    // when a letter overflows its single page.
    { angle: "motivation", sourceText: motivationSource, evidence: motivationRefs, score: 0.3 },
    { angle: "fit", sourceText: fitSource, evidence: fitRefs, score: 0.6 },
    { angle: "achievement", sourceText: achievementSource, evidence: achievementRefs, score: 0.9 },
  ];
  const angles = allAngles.filter((a) => a.evidence.length > 0);

  const items: LetterPlanItem[] = angles.map((a, i) => ({
    key: letterClaimId(i + 1),
    angle: a.angle,
    sourceText: a.sourceText,
    evidence: a.evidence,
    score: a.score,
  }));

  return {
    kind: "letter",
    items,
    jdDigest: {
      role: null,
      keywords: [...new Set(args.report.recommendedKeywords)],
      topRequirements: args.report.requirements
        .filter((r) => r.importance === "must")
        .slice(0, 5)
        .map((r) => r.text),
    },
    maxWords: LETTER_MAX_WORDS,
  };
}

// --- Stage runners (wired by pipeline.ts buildStages) ---

/** Load the pinned ProfileSnapshot data for a version: the live profile when it
 *  has not been mutated since pinning (any mutation bumps the version), else the
 *  stored snapshot row (research R5). Shared by the pipeline preconditions stage
 *  and claim-edit re-validation. */
export async function loadPinnedSnapshot(userId: string, profileVersion: number): Promise<PinnedSnapshot> {
  const profile = await getOrCreateProfile(userId);
  let data: unknown;
  if (profile.version === profileVersion) {
    // Never mutated since pinning: the live profile IS the pinned state (any
    // mutation bumps the version, so the snapshot row for v1-only profiles —
    // which commitMutation never writes — is exactly the current data).
    data = await getProfile(userId);
  } else {
    const snapshot = await db.profileSnapshot.findUnique({
      where: { profileId_version: { profileId: profile.id, version: profileVersion } },
    });
    if (!snapshot) {
      throw new Error(`No profile snapshot at pinned version ${profileVersion} — cannot build content.`);
    }
    data = snapshot.data;
  }
  return PinnedSnapshotSchema.parse(data);
}

/** Stage 1 — preconditions & pin: load the analysis, pin the ProfileSnapshot
 *  at the job's profileVersion, resolve MatchReport evidence refs against it. */
export async function runPreconditionsStage(ctx: StageContext): Promise<void> {
  const analysis = await db.jobAnalysis.findUnique({ where: { id: ctx.analysisId } });
  if (!analysis || analysis.status !== "matched" || analysis.matchReport == null) {
    throw new ApiError(
      "GENERATION_INVALID_STATE",
      "The analysis is no longer matched — generation requires a matched analysis with a stored report.",
    );
  }

  const snapshot = await loadPinnedSnapshot(ctx.userId, ctx.profileVersion);
  const report = MatchReportSchema.parse(analysis.matchReport);
  const resolved = resolveEvidenceRefs(report, snapshot);
  ctx.pinnedSnapshot = snapshot;
  ctx.matchReport = resolved.report;
  if (resolved.dangling.length > 0) {
    ctx.notice = "stale-analysis"; // skip + notice, never fabricate (research R5)
    await db.generationJob.update({ where: { id: ctx.jobId }, data: { notice: "stale-analysis" } });
  }
}

/** Stage 2 — content plan: deterministic ranking + skills list + must-include set
 *  (cv), or the angle-keyed letter plan (cover_letter, US6). For letters the
 *  current CV version's bullet/summary texts are loaded as anti-repetition
 *  input (research R11): the LLM avoids them and the Fact Guard's
 *  LETTER_DUPLICATES_CV check runs against them. */
export async function runPlanStage(ctx: StageContext): Promise<void> {
  if (!ctx.pinnedSnapshot || !ctx.matchReport) {
    throw new Error("Plan stage requires the preconditions stage output.");
  }

  if (ctx.kind === "cover_letter") {
    ctx.plan = buildLetterPlan({ snapshot: ctx.pinnedSnapshot, report: ctx.matchReport, now: new Date() });
    ctx.letterCvTexts = await currentCvTexts(ctx.analysisId);
    return;
  }

  // must-include set from the prior version's restored omissions (consumed by US5's restore route)
  let restoredOmissions: Omission[] = [];
  const document = await db.generatedDocument.findUnique({
    where: { analysisId_kind: { analysisId: ctx.analysisId, kind: ctx.kind } },
  });
  if (document) {
    // Restored omissions belong to the deliverable state — read the latest
    // SUCCESSFUL version, never a gate-failed attempt (review P2-4).
    const current = await getLatestSuccessfulVersion(document.id);
    if (current) {
      const parsed = GeneratedCVContentSchema.safeParse(current.content);
      if (parsed.success) restoredOmissions = parsed.data.omissions.filter((o) => o.restoredMustInclude === true);
    }
  }

  // NOTE(US3/T033): the must-include rendered-height pre-check (PAGE_BUDGET_CONFLICT)
  // arrives with the pdf renderer — nothing is demoted in US1.
  const plan = buildCVPlan({
    snapshot: ctx.pinnedSnapshot,
    report: ctx.matchReport,
    restoredOmissions,
    now: new Date(),
    pageBudget: ctx.settings.pageBudget, // feature 005: scales the per-section caps
  });
  ctx.plan = plan;
  ctx.selection = plan.selection ?? null; // the record the same cut produced (null for letters)
}

/** The current CV version's summary + experience/project bullet texts — the
 *  letter's anti-repetition input. Empty when no CV exists yet for the analysis
 *  (the complementarity check then simply has nothing to compare against). */
export async function currentCvTexts(analysisId: string): Promise<string[]> {
  const document = await db.generatedDocument.findUnique({
    where: { analysisId_kind: { analysisId, kind: "cv" } },
  });
  if (!document) return [];
  // Anti-repetition input comes from the latest successful CV deliverable
  // (a gate-failed attempt is not a deliverable — review P1-2 corollary).
  const current = await getLatestSuccessfulVersion(document.id);
  if (!current) return [];
  const parsed = GeneratedCVContentSchema.safeParse(current.content);
  if (!parsed.success) return [];
  const content = parsed.data;
  return [
    ...(content.summary.trim() ? [content.summary] : []),
    ...content.experience.flatMap((e) => e.bullets.map((b) => b.text)),
    ...content.projects.flatMap((p) => p.bullets.map((b) => b.text)),
  ];
}
