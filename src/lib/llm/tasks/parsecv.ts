import { z } from "zod";
import { LanguageCodeSchema, ProfileDraftSchema } from "@/lib/validation/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";
import { loadSystemPrompt } from "@/lib/llm/prompts/load";

export const ParseCvInputSchema = z.object({
  text: z.string().min(50),
  language: LanguageCodeSchema,
});

// Loaded at import (= registration) time so a missing/empty prompt file fails startup.
const SYSTEM_PROMPT = loadSystemPrompt("parseCV.md");

export function buildParseCvPrompt(payload: z.infer<typeof ParseCvInputSchema>): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Parse this CV (detected language: ${payload.language}).\n\n${payload.text}`,
    },
  ];
}

/** Idempotent so route modules can import for the side effect safely. */
export function ensureParseCvRegistered() {
  registerTask({
    name: "parseCV",
    tier: "economy",
    inputSchema: ParseCvInputSchema,
    outputSchema: ProfileDraftSchema,
    buildPrompt: (payload: unknown) => buildParseCvPrompt(ParseCvInputSchema.parse(payload)),
  });
}

ensureParseCvRegistered();
