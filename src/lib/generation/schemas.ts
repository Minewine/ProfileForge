import { createHash } from "node:crypto";
import { z } from "zod";
import { EvidenceRefSchema } from "@/lib/jobs/schemas";
import { normalizeText } from "@/lib/text/normalize";

// --- Kind & settings (data-model.md "Stored JSONB shapes") ---

export const GENERATION_KINDS = ["cv", "cover_letter"] as const;
export type GenerationKind = (typeof GENERATION_KINDS)[number];

export const OutputLanguageSchema = z.enum(["fr", "en", "de"]);
export type OutputLanguage = z.infer<typeof OutputLanguageSchema>;

export const ToneSchema = z.enum(["professional", "enthusiastic", "formal"]);
export type Tone = z.infer<typeof ToneSchema>;

/** CV render templates (phase 8): "ats" single-column (the default) or
 *  "designed" two-column. Letters always render "ats". */
export const CVTemplateIdSchema = z.enum(["ats", "designed"]);
export type CVTemplateId = z.infer<typeof CVTemplateIdSchema>;
export const DEFAULT_CV_TEMPLATE_ID = "ats";

export const DEFAULT_CV_PAGE_BUDGET = 2;
export const LETTER_PAGE_BUDGET = 1;
export const MAX_NOTES_CHARS = 2000;
export const DEFAULT_SUMMARY_MAX_WORDS = 60;

/** What the API accepts (all optional; defaults resolved against the analysis). */
export const GenerationSettingsInputSchema = z.object({
  outputLanguage: OutputLanguageSchema.optional(),
  pageBudget: z.number().int().min(1).max(3).optional(),
  tone: ToneSchema.optional(),
  notes: z.string().max(MAX_NOTES_CHARS).optional(),
  summaryMaxWords: z.number().int().min(30).max(120).optional(),
  templateId: CVTemplateIdSchema.optional(), // phase 8: render template (cv only)
});
export type GenerationSettingsInput = z.infer<typeof GenerationSettingsInputSchema>;

/** What is stored on the job — resolved and frozen at creation. */
export const GenerationSettingsSchema = z.object({
  outputLanguage: OutputLanguageSchema, // default: analysis.language (the JD's detected language)
  pageBudget: z.number().int().min(1).max(3), // default 2 (cv); cover_letter fixed at 1
  tone: ToneSchema.default("professional"),
  notes: z.string().max(MAX_NOTES_CHARS).optional(),
  summaryMaxWords: z.number().int().min(30).max(120).default(DEFAULT_SUMMARY_MAX_WORDS), // summary length bound (feature 005)
  templateId: CVTemplateIdSchema.optional(), // absent on pre-phase-8 rows ⇒ "ats" at render time
});
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;

/** POST /api/generations body. */
export const GenerationCreateSchema = z.object({
  analysisId: z.string().min(1),
  kind: z.enum(GENERATION_KINDS),
  settings: GenerationSettingsInputSchema.optional(),
});
export type GenerationCreateInput = z.infer<typeof GenerationCreateSchema>;

/**
 * Resolve user input into the frozen settings: outputLanguage defaults to the
 * analysis language, cv budget to 2, letter budget fixed at 1, tone to
 * "professional", summary length to 60 words (30..120).
 */
export function resolveGenerationSettings(args: {
  kind: GenerationKind;
  analysisLanguage: string;
  input?: GenerationSettingsInput;
}): GenerationSettings {
  return GenerationSettingsSchema.parse({
    outputLanguage: args.input?.outputLanguage ?? (args.analysisLanguage === "fr" ? "fr" : "en"),
    pageBudget:
      args.kind === "cover_letter" ? LETTER_PAGE_BUDGET : (args.input?.pageBudget ?? DEFAULT_CV_PAGE_BUDGET),
    tone: args.input?.tone ?? "professional",
    summaryMaxWords: args.input?.summaryMaxWords ?? DEFAULT_SUMMARY_MAX_WORDS,
    templateId: args.kind === "cv" ? (args.input?.templateId ?? DEFAULT_CV_TEMPLATE_ID) : DEFAULT_CV_TEMPLATE_ID,
    ...(args.input?.notes !== undefined ? { notes: args.input.notes } : {}),
  });
}

// --- Omissions & content ---

export const OmissionSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  reason: z.enum(["page_budget", "selection", "unwritten"]), // feature 005: "selection" = not selected — stronger evidence chosen
  restoredMustInclude: z.boolean().optional(),
});
export type Omission = z.infer<typeof OmissionSchema>;

/** Optional rewritten role title on a CV experience entry (feature 005). */
const ExperienceTitleSchema = z.object({
  claimId: z.string().min(1), // `expTitle.{experienceId}`
  text: z.string().min(1), // rewritten in the output language
  sourceTitle: z.string().min(1), // verbatim snapshot title (inspectability + fallback)
});

const ClaimBulletSchema = z.object({
  claimId: z.string().min(1),
  text: z.string().min(1),
  sourceBulletIds: z.array(z.string().min(1)),
  rationale: z.string().optional(),
});

export const GeneratedCVContentSchema = z.object({
  claimIdVersion: z.literal(1), // namespace for stable claim ids
  summary: z.string(),
  summaryProvenance: z.array(EvidenceRefSchema),
  experience: z.array(
    z.object({
      id: z.string().min(1), // pinned-snapshot experience id
      title: ExperienceTitleSchema.optional(), // absent in pre-feature versions
      bullets: z.array(ClaimBulletSchema),
    }),
  ),
  education: z.array(
    z.object({
      id: z.string().min(1),
      claimId: z.string().min(1),
      text: z.string().min(1),
      sourceIds: z.array(z.string().min(1)),
    }),
  ),
  projects: z.array(
    z.object({
      id: z.string().min(1),
      bullets: z.array(
        z.object({
          claimId: z.string().min(1),
          text: z.string().min(1),
          sourceBulletIds: z.array(z.string().min(1)),
        }),
      ),
    }),
  ),
  certifications: z.array(
    z.object({
      id: z.string().min(1),
      claimId: z.string().min(1),
      text: z.string().min(1),
      sourceIds: z.array(z.string().min(1)),
    }),
  ),
  skills: z.array(z.string()), // deterministic from MatchReport (R7)
  omissions: z.array(OmissionSchema),
});
export type GeneratedCVContent = z.infer<typeof GeneratedCVContentSchema>;

export const CoverLetterContentSchema = z.object({
  claimIdVersion: z.literal(1),
  paragraphs: z.array(
    z.object({
      claimId: z.string().min(1),
      text: z.string().min(1),
      evidence: z.array(EvidenceRefSchema),
    }),
  ),
  tone: z.string(),
  omissions: z.array(OmissionSchema), // expectedly empty for letters
});
export type CoverLetterContent = z.infer<typeof CoverLetterContentSchema>;

// --- Selection record (feature 005: persisted on GeneratedDocumentVersion.selection) ---

export const SELECTION_KINDS = ["experience", "project", "education", "certification"] as const;
export type SelectionEntryKind = (typeof SELECTION_KINDS)[number];

/** Per-entry justification recorded by the plan stage (data-model.md feature 005). */
export const SelectionBasisSchema = z.object({
  evidenceRefs: z.array(EvidenceRefSchema), // MatchReport citations resolving into the snapshot
  methodCredits: z.array(z.string().min(1)), // distinct match methods: exact | approved_alias | semantic
  recency: z.number().min(0).max(1), // the plan's recency component
});
export type SelectionBasis = z.infer<typeof SelectionBasisSchema>;

/** Excluded entries are NOT duplicated here — they live in content.omissions
 *  with reason "selection". Immutable once persisted; regeneration writes a new version. */
export const SelectionRecordSchema = z.object({
  included: z.array(
    z.object({
      entryId: z.string().min(1), // pinned-snapshot entry id
      kind: z.enum(SELECTION_KINDS),
      rank: z.number().int().min(1), // 1-based within its section, before the cut
      score: z.number(), // the plan's unit score
      basis: SelectionBasisSchema,
    }),
  ),
  generatedAt: z.string().min(1), // ISO timestamp of the plan that produced it
});
export type SelectionRecord = z.infer<typeof SelectionRecordSchema>;

// --- Validation report ---

export const ValidationFlagSchema = z.object({
  code: z.string().min(1), // contracts/generation-pipeline.md §Fact Guard
  claim: z.string().min(1), // claimId addressed
  severity: z.enum(["blocker", "warning"]),
  affectedFieldIds: z.array(z.string()).optional(),
  sourceEvidence: z.array(EvidenceRefSchema).optional(),
  resolution: z.enum(["pending", "user_confirmed", "edited", "removed"]),
  confirmedAt: z.string().optional(), // attribution when user_confirmed
});
export type ValidationFlag = z.infer<typeof ValidationFlagSchema>;

export const ValidationReportSchema = z.object({
  layersRun: z.object({
    deterministic: z.literal(true), // always runs, zero AI
    semantic: z.boolean(), // false ⇒ fail-closed gate
  }),
  flags: z.array(ValidationFlagSchema),
  summary: z.object({ blockers: z.number().int().min(0), warnings: z.number().int().min(0) }),
});
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

// --- Artifacts & confirmations ---

export const ArtifactMetaSchema = z.object({
  format: z.enum(["pdf", "docx", "txt"]),
  storagePath: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().min(0),
  gate: z.enum(["verified", "best_effort", "none"]), // pdf=verified after passing; docx=best_effort; txt=none
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

export const ClaimFingerprintSchema = z.object({
  fingerprint: z.string().min(1),
  confirmedAt: z.string().min(1),
});
export type ClaimFingerprint = z.infer<typeof ClaimFingerprintSchema>;

// --- Stable claim ids (data-model.md: valid within a version) ---

export const CLAIM_ID_VERSION = 1;

export function summaryClaimId(): string {
  return "summary";
}

export function experienceClaimId(experienceId: string, n: number): string {
  return `exp.${experienceId}.${n}`;
}

export function titleClaimId(experienceId: string): string {
  return `expTitle.${experienceId}`;
}

export function projectClaimId(projectId: string, n: number): string {
  return `proj.${projectId}.${n}`;
}

export function educationClaimId(educationId: string): string {
  return `edu.${educationId}`;
}

export function certificationClaimId(certificationId: string): string {
  return `cert.${certificationId}`;
}

export function letterClaimId(n: number): string {
  return `letter.${n}`;
}

export type ParsedClaimId =
  | { kind: "summary" }
  | { kind: "experience"; experienceId: string; n: number }
  | { kind: "experienceTitle"; experienceId: string }
  | { kind: "project"; projectId: string; n: number }
  | { kind: "education"; educationId: string }
  | { kind: "certification"; certificationId: string }
  | { kind: "letter"; n: number };

/** Inverse of the claim-id builders; null when the id matches no namespace. */
export function parseClaimId(claimId: string): ParsedClaimId | null {
  if (claimId === "summary") return { kind: "summary" };
  const parts = claimId.split(".");
  if (parts.length === 3 && parts[0] === "exp" && parts[2] !== "") {
    const n = Number(parts[2]);
    if (Number.isInteger(n) && n >= 1) return { kind: "experience", experienceId: parts[1], n };
  }
  if (parts.length === 3 && parts[0] === "proj" && parts[2] !== "") {
    const n = Number(parts[2]);
    if (Number.isInteger(n) && n >= 1) return { kind: "project", projectId: parts[1], n };
  }
  if (parts.length === 2 && parts[0] === "expTitle" && parts[1] !== "") {
    return { kind: "experienceTitle", experienceId: parts[1] };
  }
  if (parts.length === 2 && parts[0] === "edu" && parts[1] !== "") {
    return { kind: "education", educationId: parts[1] };
  }
  if (parts.length === 2 && parts[0] === "cert" && parts[1] !== "") {
    return { kind: "certification", certificationId: parts[1] };
  }
  if (parts.length === 2 && parts[0] === "letter" && parts[1] !== "") {
    const n = Number(parts[1]);
    if (Number.isInteger(n) && n >= 1) return { kind: "letter", n };
  }
  return null;
}

// --- Cross-version confirmation identity (R10) ---

/** `sha256(normalizeText(claimText) + "|" + sorted(evidenceIds).join(","))` */
export function claimFingerprint(claimText: string, evidenceIds: string[]): string {
  const sorted = [...evidenceIds].sort();
  return createHash("sha256").update(`${normalizeText(claimText)}|${sorted.join(",")}`).digest("hex");
}
