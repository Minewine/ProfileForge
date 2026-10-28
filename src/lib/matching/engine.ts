import { normalizeText } from "@/lib/text/normalize";
import { sameAliasGroup } from "@/lib/matching/aliases";
import type { EvidenceRef, MatchMethod, MatchStatus, RequirementMatch } from "@/lib/jobs/schemas";
import type { ProfileDto } from "@/lib/profile/repository";

export type SemanticProposal = { requirementIndex: number; entryIds: string[]; rationale?: string };

export type EngineRequirement = {
  id: string;
  text: string;
  category: string;
  importance: string;
  isHardConstraint: boolean;
  userConfirmed: boolean;
};

export type EngineResult = {
  matches: RequirementMatch[];
  /** count of LLM proposals rejected by evidence validation (SC-005) */
  semanticDropped: number;
  /** hard requirements for which semantic proposals existed — eligible for user confirmation (FR-007) */
  confirmable: Record<string, string[]>;
  /** non-hard requirements still unmatched after all layers — input for the semantic task */
  unmatchedNonHard: Array<{ index: number; text: string }>;
};

type StructuredTerm = { normalized: string; evidence: EvidenceRef };

const SKILL_TOOL_CATEGORIES = new Set(["skill", "tool"]);

/**
 * Deterministic matching engine (contracts/matching-engine.md): exact →
 * approved alias → validated semantic. Pure — no LLM calls. The LLM proposes;
 * this module disposes: EvidenceRefs are always built from real entries.
 */
export function matchRequirements(
  requirements: EngineRequirement[],
  profile: ProfileDto,
  proposals: SemanticProposal[] | null = null,
): EngineResult {
  const terms = structuredTerms(profile);
  const bulletTexts = allBullets(profile).map((b) => ({ id: b.id, normalized: normalizeText(b.text), raw: b.text }));
  const skillsUsed = allSkillsUsed(profile);
  const entryById = buildEvidenceIndex(profile);

  const matches: RequirementMatch[] = [];
  const confirmable: Record<string, string[]> = {};
  const semanticByIndex = new Map<number, SemanticProposal[]>();
  let semanticDropped = 0;

  if (proposals) {
    for (const p of proposals) {
      const valid = p.entryIds.filter((id) => entryById.has(id));
      if (valid.length === 0) {
        semanticDropped++;
        continue;
      }
      const list = semanticByIndex.get(p.requirementIndex) ?? [];
      list.push({ ...p, entryIds: valid });
      semanticByIndex.set(p.requirementIndex, list);
    }
  }

  for (const [index, req] of requirements.entries()) {
    const normalizedReq = normalizeText(req.text);

    // Layer 1+2: deterministic exact, then approved alias (structured fields only).
    // Exact = normalized equality, or the structured term appearing as a whole
    // phrase inside the requirement text ("exposure to project management" ⊃
    // "project management") — longest term wins.
    const exact =
      terms.find((t) => t.normalized === normalizedReq) ??
      longestContainedTerm(terms, normalizedReq);
    const alias = exact ? undefined : terms.find((t) => sameAliasGroup(normalizedReq, t.normalized, profile));

    if (exact || alias) {
      const method: MatchMethod = exact ? "exact" : "approved_alias";
      const baseEvidence = exact ? [exact.evidence] : [alias!.evidence];
      // usage is judged on the MATCHED term (alias/containment may map to a
      // different surface form than the requirement text)
      const matchedNorm = exact ? exact.normalized : alias!.normalized;
      const usageBullets = bulletTexts.filter((b) => containsTerm(b.normalized, matchedNorm));
      const usedInRole = skillsUsed.has(matchedNorm) || usageBullets.length > 0;

      const usageCategory = SKILL_TOOL_CATEGORIES.has(req.category);
      const status: MatchStatus = usageCategory && !usedInRole ? "partial" : "strong";

      const evidence = dedupeEvidence([
        ...baseEvidence,
        ...usageBullets.slice(0, 3).map((b) => ref("bullet", b.id, b.raw)),
      ]);

      matches.push({
        id: req.id,
        text: req.text,
        importance: req.importance as "must" | "nice",
        isHardConstraint: req.isHardConstraint,
        status,
        matchMethod: method,
        evidence,
        note:
          status === "partial"
            ? `Term found in the profile but with no recorded usage — confirm usage by adding it to a role.`
            : null,
        ...(req.userConfirmed ? { userConfirmed: true } : {}),
      });
      continue;
    }

    // Layer 3: semantic — non-hard only, evidence-validated (FR-006/FR-007)
    const reqProposals = semanticByIndex.get(index) ?? [];
    if (!req.isHardConstraint && reqProposals.length > 0) {
      const best = reqProposals[0];
      matches.push({
        id: req.id,
        text: req.text,
        importance: req.importance as "must" | "nice",
        isHardConstraint: false,
        status: "strong",
        matchMethod: "semantic",
        evidence: dedupeEvidence(best.entryIds.map((id) => entryById.get(id)!)),
        note: best.rationale ?? null,
      });
      continue;
    }

    // Hard constraints with (dropped-or-valid) proposals are confirmable, never auto-matched
    if (req.isHardConstraint && reqProposals.length > 0) {
      confirmable[req.id] = reqProposals[0].entryIds;
    }
    matches.push({
      id: req.id,
      text: req.text,
      importance: req.importance as "must" | "nice",
      isHardConstraint: req.isHardConstraint,
      status: req.userConfirmed ? "strong" : "gap",
      matchMethod: req.userConfirmed ? "semantic" : "none",
      evidence: req.userConfirmed && confirmable[req.id]
        ? dedupeEvidence(confirmable[req.id].map((id) => entryById.get(id)!))
        : [],
      note: null,
      ...(req.userConfirmed ? { userConfirmed: true } : {}),
    });
  }

  const unmatchedNonHard = matches
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => !m.isHardConstraint && m.status === "gap" && m.matchMethod === "none")
    .map(({ index }) => ({ index, text: requirements[index].text }));

  return { matches, semanticDropped, confirmable, unmatchedNonHard };
}

/** Evidence index used for validation and for building refs from entry IDs. */
export function buildEvidenceIndex(profile: ProfileDto): Map<string, EvidenceRef> {
  return new Map([
    ...profile.skills.map((s) => [s.id, ref("skill", s.id, s.name)] as const),
    ...profile.certifications.map((c) => [c.id, ref("certification", c.id, [c.title, c.issuer].filter(Boolean).join(" · "))] as const),
    ...profile.education.map((e) => [e.id, ref("education", e.id, [e.degree, e.field, e.institution].filter(Boolean).join(" · "))] as const),
    ...allBullets(profile).map((b) => [b.id, ref("bullet", b.id, b.text)] as const),
    ...profile.experience.map((e) => [e.id, ref("bullet", e.id, `${e.title} — ${e.company}`)] as const),
    ...profile.projects.map((p) => [p.id, ref("bullet", p.id, p.name)] as const),
  ]);
}

/** Recommended = matched terms; missing = gap/partial terms (must > nice ordering). */
export function deriveKeywords(matches: RequirementMatch[]): {
  recommended: string[];
  missing: string[];
} {
  const rank = (m: RequirementMatch) => (m.importance === "must" ? 0 : 1);
  const byRank = [...matches].sort((a, b) => rank(a) - rank(b));
  return {
    recommended: byRank.filter((m) => m.status === "strong").map((m) => m.text),
    missing: byRank.filter((m) => m.status === "gap" || m.status === "partial").map((m) => m.text),
  };
}

// --- helpers ---

function ref(type: EvidenceRef["type"], id: string, snippet: string): EvidenceRef {
  return { type, id, snippet: snippet.slice(0, 200) };
}

function dedupeEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

function longestContainedTerm(terms: StructuredTerm[], normalizedReq: string): StructuredTerm | undefined {
  const wordBounded = (hay: string, needle: string) =>
    needle.length >= 3 && new RegExp(`(^| )${escapeRegExp(needle)}( |$)`).test(hay);
  const hits = terms.filter((t) => t.normalized.length >= 3 && wordBounded(normalizedReq, t.normalized));
  return hits.sort((a, b) => b.normalized.length - a.normalized.length)[0];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTerm(normalizedHaystack: string, normalizedTerm: string): boolean {
  if (!normalizedTerm) return false;
  return normalizedHaystack.includes(normalizedTerm);
}

function allBullets(profile: ProfileDto): Array<{ id: string; text: string }> {
  return [
    ...profile.experience.flatMap((e) => e.bullets ?? []),
    ...profile.projects.flatMap((p) => p.bullets ?? []),
  ];
}

function allSkillsUsed(profile: ProfileDto): Set<string> {
  const set = new Set<string>();
  for (const e of profile.experience) {
    for (const s of e.skillsUsed ?? []) set.add(normalizeText(s));
  }
  return set;
}

function structuredTerms(profile: ProfileDto): StructuredTerm[] {
  const terms: StructuredTerm[] = [];
  for (const s of profile.skills) terms.push({ normalized: normalizeText(s.name), evidence: ref("skill", s.id, s.name) });
  for (const c of profile.certifications) terms.push({ normalized: normalizeText(c.title), evidence: ref("certification", c.id, c.title) });
  for (const l of profile.languages) terms.push({ normalized: normalizeText(l.name), evidence: ref("skill", l.id, l.name) });
  for (const e of profile.experience) {
    for (const s of e.skillsUsed ?? []) {
      terms.push({
        normalized: normalizeText(s),
        evidence: ref("bullet", e.id, `${e.title} — ${e.company}`),
      });
    }
  }
  return terms;
}
