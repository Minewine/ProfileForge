import { ApiError } from "@/lib/api/errors";
import {
  applyProvenanceInvariants,
  CertificationInputSchema,
  CertificationPatchSchema,
  EducationInputSchema,
  EducationPatchSchema,
  ExperienceInputSchema,
  ExperiencePatchSchema,
  LanguageSkillInputSchema,
  LanguageSkillPatchSchema,
  ProjectInputSchema,
  ProjectPatchSchema,
  SECTION_NAMES,
  SkillInputSchema,
  SkillPatchSchema,
  type SectionName,
} from "@/lib/validation/schemas";

/** Create payloads (with provenance invariants) + partial autosave payloads per section. */
export const CreateSchemas = {
  experience: applyProvenanceInvariants(ExperienceInputSchema),
  education: applyProvenanceInvariants(EducationInputSchema),
  skills: applyProvenanceInvariants(SkillInputSchema),
  languages: applyProvenanceInvariants(LanguageSkillInputSchema),
  projects: applyProvenanceInvariants(ProjectInputSchema),
  certifications: applyProvenanceInvariants(CertificationInputSchema),
} as const;

/** Strictly partial: a key absent from the body is absent from the parsed patch (spec 007). */
export const PatchSchemas = {
  experience: ExperiencePatchSchema,
  education: EducationPatchSchema,
  skills: SkillPatchSchema,
  languages: LanguageSkillPatchSchema,
  projects: ProjectPatchSchema,
  certifications: CertificationPatchSchema,
} as const;

export function parseSection(raw: string): SectionName {
  if (!SECTION_NAMES.includes(raw as SectionName)) {
    throw new ApiError("NOT_FOUND", `Unknown profile section "${raw}".`);
  }
  return raw as SectionName;
}
