import { z } from "zod";

// --- Shared primitives ---

export const ProvenanceSchema = z.enum(["imported", "user_entered", "user_confirmed"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const LanguageCodeSchema = z.enum(["fr", "en"]);
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;

export const ReviewFlagSchema = z.enum([
  "low_confidence",
  "containment_failed",
  "ambiguous_date",
  "missing_dates",
]);
export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;

/** YYYY-MM strictly, or the literal "present" (end dates only). */
export const YearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");
export const EndDateSchema = z.union([YearMonthSchema, z.literal("present")]);

export const SourceLocatorSchema = z.object({
  page: z.number().int().min(1).optional(),
  paragraphIndex: z.number().int().min(0).optional(),
  section: z.string().max(120).optional(),
});
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

/**
 * Provenance fields as a PLAIN object (no refinements) so section schemas stay
 * `.partial()`-able for autosave PATCHes. The invariants below are enforced on
 * the create path via `applyProvenanceInvariants` (see sectionSchemas.ts).
 */
export const ProvenanceFieldsSchema = z.object({
  provenance: ProvenanceSchema.default("user_entered"),
  sourceDocumentId: z.string().min(1).nullish(),
  sourceLocator: SourceLocatorSchema.nullish(),
  language: LanguageCodeSchema.nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  reviewFlag: ReviewFlagSchema.nullish(),
});
export type ProvenanceFields = z.infer<typeof ProvenanceFieldsSchema>;

/** Provenance invariant (FR-003): imported ⇒ sourceDocumentId + sourceLocator present. */
export function applyProvenanceInvariants<T extends z.ZodObject>(schema: T) {
  return schema
    .refine(
      (v) =>
        (v.provenance ?? "user_entered") !== "imported" ||
        (v.sourceDocumentId != null && v.sourceLocator != null),
      { message: "imported entries require sourceDocumentId and sourceLocator" },
    )
    .refine((v) => (v.provenance ?? "user_entered") === "imported" || v.confidence == null, {
      message: "confidence is only set on imported entries",
    });
}

// --- Basics ---

/** Scheme-less values ("www.x.com/a") are normalized to https://; anything
 *  that is not an http(s) URL after that is rejected. Bare `.url()` is not
 *  enough: `new URL()` accepts scheme-only garbage such as
 *  "www.rametric.com:www.rametric.com" (parsed scheme "www.rametric.com") —
 *  the LLM parser emitted exactly that in the wild, and it must never reach
 *  the profile. Normalization also rescues scheme-less links that plain
 *  `.url()` would reject (https:// prefix on "www.linkedin.com/in/..."). */
const HttpUrlSchema = z
  .string()
  .trim()
  .transform((v) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`))
  .pipe(z.string().url().refine((v) => /^https?:\/\//i.test(v), { message: "must be an http(s) URL" }));

/** Normalize a raw link value from any source (LLM parse draft, user input):
 *  non-string/blank/unrecoverable → null. A bad link is never worth failing a
 *  parse or a save over, so callers drop instead of erroring. */
export function normalizeLink(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = HttpUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Links list: invalid entries are DROPPED, never fail the payload. */
export const LinksSchema = z
  .array(z.unknown())
  .max(10)
  .transform((arr) => arr.flatMap((item) => normalizeLink(item) ?? []));

export const BasicsSchema = z.object({
  name: z.string().min(1).max(200),
  headline: z.string().max(300).nullish(),
  summary: z.string().max(4000).nullish(),
  location: z.string().max(200).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(50).nullish(),
  links: LinksSchema.nullish(),
});
export type Basics = z.infer<typeof BasicsSchema>;

// --- Bullets & sections ---

export const BulletInputSchema = ProvenanceFieldsSchema.extend({
  id: z.string().optional(), // absent ⇒ new bullet (server assigns id)
  text: z.string().min(1).max(2000),
  containmentOk: z.boolean().nullish(),
  order: z.number().int().default(0),
});

export const ExperienceInputSchema = ProvenanceFieldsSchema.extend({
  company: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  location: z.string().max(200).nullish(),
  startDate: YearMonthSchema.nullish(),
  endDate: EndDateSchema.nullish(),
  skillsUsed: z.array(z.string().min(1).max(120)).default([]),
  order: z.number().int().default(0),
  bullets: z.array(BulletInputSchema).default([]),
});

export const EducationInputSchema = ProvenanceFieldsSchema.extend({
  institution: z.string().min(1).max(200),
  degree: z.string().max(200).nullish(),
  field: z.string().max(200).nullish(),
  startDate: YearMonthSchema.nullish(),
  endDate: EndDateSchema.nullish(),
  grade: z.string().max(50).nullish(),
  order: z.number().int().default(0),
});

export const SkillInputSchema = ProvenanceFieldsSchema.extend({
  name: z.string().min(1).max(120),
  category: z.string().max(120).nullish(),
  aliases: z.array(z.string().min(1).max(120)).default([]), // user-approved only (FR-007)
  level: z.string().max(120).nullish(), // user-stated only (FR-006)
  order: z.number().int().default(0),
});

export const LanguageSkillInputSchema = ProvenanceFieldsSchema.extend({
  name: z.string().min(1).max(120),
  proficiency: z.string().max(120).nullish(),
  order: z.number().int().default(0),
});

export const ProjectInputSchema = ProvenanceFieldsSchema.extend({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  link: HttpUrlSchema.nullish(),
  startDate: YearMonthSchema.nullish(),
  endDate: EndDateSchema.nullish(),
  order: z.number().int().default(0),
  bullets: z.array(BulletInputSchema).default([]),
});

export const CertificationInputSchema = ProvenanceFieldsSchema.extend({
  title: z.string().min(1).max(200),
  issuer: z.string().max(200).nullish(),
  issueDate: YearMonthSchema.nullish(),
  order: z.number().int().default(0),
});

// --- Autosave patch variants (strictly partial) ---

/**
 * Patch variants for autosave PATCHes: a key absent from the request body must
 * be absent from the parsed patch. zod 4's `.partial()` does NOT suppress
 * `.default()`, so these mirror the input schemas with every field optional
 * and no defaults. Keep constraints in sync with the input schemas above.
 */
const ProvenancePatchFields = z.object({
  provenance: ProvenanceSchema.optional(),
  sourceDocumentId: z.string().min(1).nullish(),
  sourceLocator: SourceLocatorSchema.nullish(),
  language: LanguageCodeSchema.nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  reviewFlag: ReviewFlagSchema.nullish(),
});

export const BulletPatchSchema = ProvenancePatchFields.extend({
  id: z.string().optional(), // present ⇒ update in place; absent ⇒ create
  text: z.string().min(1).max(2000),
  containmentOk: z.boolean().nullish(),
  order: z.number().int().optional(), // absent ⇒ server assigns from array index
});

export const ExperiencePatchSchema = ProvenancePatchFields.extend({
  company: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  location: z.string().max(200).nullish(),
  startDate: YearMonthSchema.nullish(),
  endDate: EndDateSchema.nullish(),
  skillsUsed: z.array(z.string().min(1).max(120)).optional(),
  order: z.number().int().optional(),
  bullets: z.array(BulletPatchSchema).optional(),
});

export const EducationPatchSchema = ProvenancePatchFields.extend({
  institution: z.string().min(1).max(200).optional(),
  degree: z.string().max(200).nullish(),
  field: z.string().max(200).nullish(),
  startDate: YearMonthSchema.nullish(),
  endDate: EndDateSchema.nullish(),
  grade: z.string().max(50).nullish(),
  order: z.number().int().optional(),
});

export const SkillPatchSchema = ProvenancePatchFields.extend({
  name: z.string().min(1).max(120).optional(),
  category: z.string().max(120).nullish(),
  aliases: z.array(z.string().min(1).max(120)).optional(),
  level: z.string().max(120).nullish(),
  order: z.number().int().optional(),
});

export const LanguageSkillPatchSchema = ProvenancePatchFields.extend({
  name: z.string().min(1).max(120).optional(),
  proficiency: z.string().max(120).nullish(),
  order: z.number().int().optional(),
});

export const ProjectPatchSchema = ProvenancePatchFields.extend({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  link: HttpUrlSchema.nullish(),
  startDate: YearMonthSchema.nullish(),
  endDate: EndDateSchema.nullish(),
  order: z.number().int().optional(),
  bullets: z.array(BulletPatchSchema).optional(),
});

export const CertificationPatchSchema = ProvenancePatchFields.extend({
  title: z.string().min(1).max(200).optional(),
  issuer: z.string().max(200).nullish(),
  issueDate: YearMonthSchema.nullish(),
  order: z.number().int().optional(),
});

export const SECTION_NAMES = [
  "experience",
  "education",
  "skills",
  "languages",
  "projects",
  "certifications",
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export const SectionInputSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("experience"), data: ExperienceInputSchema }),
  z.object({ section: z.literal("education"), data: EducationInputSchema }),
  z.object({ section: z.literal("skills"), data: SkillInputSchema }),
  z.object({ section: z.literal("languages"), data: LanguageSkillInputSchema }),
  z.object({ section: z.literal("projects"), data: ProjectInputSchema }),
  z.object({ section: z.literal("certifications"), data: CertificationInputSchema }),
]);

// --- Provenance transition (PATCH { provenance }) ---
// imported → user_confirmed only with an open review flag; it clears the flag.

export const ProvenanceTransitionSchema = z
  .object({ provenance: ProvenanceSchema })
  .refine((v) => v.provenance !== "imported", {
    message: "provenance cannot be set back to imported through the API",
  });

// --- ProfileDraft (parseCV LLM output, per contracts/parsecv-task.md) ---
// Dates arrive raw from the LLM; normalization is deterministic code (never the LLM).

const RawDates = {
  startDateRaw: z.string().max(60).nullish(),
  endDateRaw: z.string().max(60).nullish(),
};

export const ProfileDraftSchema = z.object({
  basics: BasicsSchema.partial({ name: true }).nullish(),
  experience: z
    .array(
      z.object({
        company: z.string().min(1),
        title: z.string().min(1),
        location: z.string().nullish(),
        ...RawDates,
        bullets: z
          .array(z.object({ text: z.string().min(1), page: z.number().int().min(1).nullish() }))
          .default([]),
        skillsUsed: z.array(z.string()).default([]),
        page: z.number().int().min(1).nullish(),
      }),
    )
    .default([]),
  education: z
    .array(
      z.object({
        institution: z.string().min(1),
        degree: z.string().nullish(),
        field: z.string().nullish(),
        ...RawDates,
        page: z.number().int().min(1).nullish(),
      }),
    )
    .default([]),
  skills: z
    .array(z.object({ name: z.string().min(1), category: z.string().nullish(), page: z.number().int().min(1).nullish() }))
    .default([]),
  languages: z
    .array(z.object({ name: z.string().min(1), proficiency: z.string().nullish(), page: z.number().int().min(1).nullish() }))
    .default([]),
  projects: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().nullish(),
        link: z.string().nullish(),
        ...RawDates,
        page: z.number().int().min(1).nullish(),
      }),
    )
    .default([]),
  certifications: z
    .array(
      z.object({
        title: z.string().min(1),
        issuer: z.string().nullish(),
        issueDateRaw: z.string().nullish(),
        page: z.number().int().min(1).nullish(),
      }),
    )
    .default([]),
});
export type ProfileDraft = z.infer<typeof ProfileDraftSchema>;

// --- Mutation results ---

export const WarningSchema = z.object({ code: z.string(), message: z.string() });
export type Warning = z.infer<typeof WarningSchema>;
