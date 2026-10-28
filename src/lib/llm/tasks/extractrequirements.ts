import { z } from "zod";
import { LanguageCodeSchema } from "@/lib/validation/schemas";
import { REQUIREMENT_CATEGORIES } from "@/lib/jobs/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";

export const ExtractRequirementsInputSchema = z.object({
  text: z.string().min(50),
  language: LanguageCodeSchema,
});

export const ExtractRequirementsOutputSchema = z.object({
  requirements: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        category: z.enum(REQUIREMENT_CATEGORIES),
        importance: z.enum(["must", "nice"]),
        isHardConstraint: z.boolean(),
      }),
    )
    .max(100),
});

const SYSTEM_PROMPT = `You are a precise job-description requirement extractor.
Rules (non-negotiable):
- Extract ONLY requirements explicitly stated in the provided text. Do not invent, infer, or merge requirements.
- Each requirement's text is a CONCISE phrase naming the requirement itself, kept in the document's language — e.g. "Kubernetes", "5+ years of Go", "CKA certification", "Bachelor's degree in Computer Science" — NOT the full sentence around it. When the requirement is a named skill, tool, certification, or language, output ONLY the name (e.g. "Kubernetes", "Go", "French"); drop qualifiers such as "experience with", "familiarity with", "exposure to". Matching works on these terms, so keep them short and canonical.
- importance must follow the document's own markers: "must" for required/mandatory wording (e.g. "required", "exigé", "obligatoire", "vous devez"), "nice" for optional wording (e.g. "nice to have", "plus", "atout", "un plus").
- isHardConstraint is true ONLY for required tools, certifications, licenses, or explicit years of experience.
- category is one of: skill, tool, years_experience, education, domain, language, other.
- If nothing states a requirement, return an empty list. A missing requirement is better than an invented one.
- Respond ONLY with JSON matching the schema.`;

export function ensureExtractRequirementsRegistered() {
  registerTask({
    name: "extractRequirements",
    tier: "economy",
    inputSchema: ExtractRequirementsInputSchema,
    outputSchema: ExtractRequirementsOutputSchema,
    buildPrompt: (payload: unknown): ChatMessage[] => {
      const { text, language } = ExtractRequirementsInputSchema.parse(payload);
      return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Extract the requirements from this job description (language: ${language}).\n\n${text}` },
      ];
    },
  });
}

ensureExtractRequirementsRegistered();
