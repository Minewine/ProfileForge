import { z } from "zod";
import { LanguageCodeSchema } from "@/lib/validation/schemas";

// --- Job analysis ---

export const ANALYSIS_STATUSES = ["created", "extracted", "finalized", "matched", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const MIN_JD_CHARS = 200;
export const MAX_JD_CHARS = 100_000;

// Length guards live in the repository so they surface as JD_TOO_SHORT / JD_TOO_LONG
// (with guidance) instead of a generic validation error.
export const JobCreateSchema = z.object({ text: z.string().min(1) });
export const LanguagePatchSchema = z.object({ language: LanguageCodeSchema });

// --- Requirements ---

export const REQUIREMENT_CATEGORIES = [
  "skill",
  "tool",
  "years_experience",
  "education",
  "domain",
  "language",
  "other",
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export const RequirementInputSchema = z.object({
  text: z.string().min(1).max(500),
  category: z.enum(REQUIREMENT_CATEGORIES),
  importance: z.enum(["must", "nice"]),
  isHardConstraint: z.boolean().default(false),
});

export const RequirementsPutSchema = z.object({
  requirements: z.array(RequirementInputSchema).max(100),
  finalize: z.boolean().default(false),
});

// --- Matching (canonical §4 shapes + slice extensions) ---

export const MatchMethodSchema = z.enum(["exact", "approved_alias", "semantic", "none"]);
export type MatchMethod = z.infer<typeof MatchMethodSchema>;

export const MatchStatusSchema = z.enum(["strong", "partial", "gap"]);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

export const EvidenceRefSchema = z.object({
  type: z.enum(["bullet", "skill", "education", "certification"]),
  id: z.string(),
  snippet: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const RequirementMatchSchema = z.object({
  id: z.string(),
  text: z.string(),
  importance: z.enum(["must", "nice"]),
  isHardConstraint: z.boolean(),
  status: MatchStatusSchema,
  matchMethod: MatchMethodSchema,
  evidence: z.array(EvidenceRefSchema),
  note: z.string().nullish(),
  userConfirmed: z.boolean().optional(),
});
export type RequirementMatch = z.infer<typeof RequirementMatchSchema>;

export const ScoreBreakdownSchema = z.object({
  hardRequirementsMet: z.number().int(),
  preferredRequirementsMet: z.number().int(),
  exactMatches: z.number().int(),
  aliasMatches: z.number().int(),
  semanticMatches: z.number().int(),
  hardWeight: z.number(),
  preferredWeight: z.number(),
  evidenceBonus: z.number(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const MatchReportSchema = z.object({
  overallScore: z.number().int().min(0).max(100),
  scoreBreakdown: ScoreBreakdownSchema,
  requirements: z.array(RequirementMatchSchema),
  recommendedKeywords: z.array(z.string()),
  missingKeywords: z.array(z.string()),
  semanticDropped: z.number().int(),
});
export type MatchReport = z.infer<typeof MatchReportSchema>;

/** Slice extension: hard constraints for which semantic proposals existed — the only
 *  requirements eligible for user confirmation (evidence-gated, FR-007). */
export const ConfirmableSemanticSchema = z.record(z.string(), z.array(z.string().min(1)));
export type ConfirmableSemantic = Record<string, string[]>;

/** The stored report = canonical MatchReport + the confirmable extension. */
export type MatchReportExtras = { confirmable: ConfirmableSemantic };
