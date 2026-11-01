import { z } from "zod";
import { LanguageCodeSchema } from "@/lib/validation/schemas";
import { REQUIREMENT_CATEGORIES } from "@/lib/jobs/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";
import { loadSystemPrompt } from "@/lib/llm/prompts/load";

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
  role: z.string().min(1).max(200).nullish(),
  company: z.string().min(1).max(200).nullish(),
});

// Loaded at import (= registration) time so a missing/empty prompt file fails startup.
const SYSTEM_PROMPT = loadSystemPrompt("extractRequirements.md");

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
