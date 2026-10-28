import type { MatchReport, RequirementMatch, ScoreBreakdown } from "@/lib/jobs/schemas";

/**
 * Pure score computation — the parent spec's clarified formula, verbatim:
 * hard 60 + preferred 30 + evidence bonus 0–10; per-requirement credit
 * exact 1.0 / approved alias 0.9 / semantic 0.7 / partial 0.5 / gap 0;
 * semantic credit never applies to hard constraints; an empty bucket's
 * weight shifts to the other; bonus = 10 × share of matched requirements
 * whose evidence includes an experience/project bullet; rounded integer.
 */

export function matchCredit(m: RequirementMatch): number {
  if (m.status === "gap") return 0;
  if (m.status === "partial") return 0.5;
  if (m.userConfirmed) return 0.7; // confirmed semantic on a hard constraint
  switch (m.matchMethod) {
    case "exact":
      return 1.0;
    case "approved_alias":
      return 0.9;
    case "semantic":
      return 0.7;
    default:
      return 0;
  }
}

export function scoreReport(matches: RequirementMatch[]): {
  overallScore: number;
  scoreBreakdown: ScoreBreakdown;
} {
  const hard = matches.filter((m) => m.isHardConstraint);
  const preferred = matches.filter((m) => !m.isHardConstraint);

  const hardCredit = (m: RequirementMatch) =>
    m.matchMethod === "exact" || m.matchMethod === "approved_alias" || m.userConfirmed
      ? matchCredit(m)
      : 0; // semantic never satisfies a hard constraint (FR-007)

  let hardWeight = 60;
  let preferredWeight = 30;
  if (hard.length === 0 && preferred.length > 0) {
    hardWeight = 0;
    preferredWeight = 90;
  } else if (preferred.length === 0 && hard.length > 0) {
    hardWeight = 90;
    preferredWeight = 0;
  }

  const hardSum = hard.reduce((acc, m) => acc + hardCredit(m), 0);
  const preferredSum = preferred.reduce((acc, m) => acc + matchCredit(m), 0);
  const hardBucket = hard.length === 0 || hardWeight === 0 ? 0 : (hardSum / hard.length) * hardWeight;
  const preferredBucket =
    preferred.length === 0 || preferredWeight === 0 ? 0 : (preferredSum / preferred.length) * preferredWeight;

  const matched = matches.filter((m) => m.status !== "gap");
  const bulletEvidenced = matched.filter((m) =>
    m.evidence.some((e) => e.type === "bullet"),
  ).length;
  const evidenceBonus = matched.length === 0 ? 0 : (bulletEvidenced / matched.length) * 10;

  const breakdown: ScoreBreakdown = {
    hardRequirementsMet: hard.filter((m) => m.status !== "gap").length,
    preferredRequirementsMet: preferred.filter((m) => m.status !== "gap").length,
    exactMatches: matches.filter((m) => m.matchMethod === "exact" && m.status !== "gap").length,
    aliasMatches: matches.filter((m) => m.matchMethod === "approved_alias" && m.status !== "gap").length,
    semanticMatches: matches.filter((m) => m.matchMethod === "semantic" && m.status !== "gap").length,
    hardWeight,
    preferredWeight,
    evidenceBonus: Math.round(evidenceBonus * 100) / 100,
  };

  return {
    overallScore: Math.round(hardBucket + preferredBucket + evidenceBonus),
    scoreBreakdown: breakdown,
  };
}

/** SC-004: recomputing from a stored report's matches must reproduce the score exactly. */
export function recomputeScore(report: Pick<MatchReport, "requirements" | "overallScore">): boolean {
  return scoreReport(report.requirements).overallScore === report.overallScore;
}
