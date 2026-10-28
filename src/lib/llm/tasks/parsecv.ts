import { z } from "zod";
import { LanguageCodeSchema, ProfileDraftSchema } from "@/lib/validation/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";

export const ParseCvInputSchema = z.object({
  text: z.string().min(50),
  language: LanguageCodeSchema,
});

const SYSTEM_PROMPT = `You are a precise CV parsing engine.
Rules (non-negotiable):
- Use ONLY facts present in the provided text. Do NOT invent, infer, or complete employers, titles, dates, skills, tools, metrics, degrees, or achievements.
- When unsure, OMIT the field entirely.
- Reproduce bullet text FAITHFULLY — do not polish, merge, split, or rewrite bullets.
- Return the page locator for every item you extract (the page markers are <<<PAGE n>>>).
- Dates: return the RAW date string exactly as written (e.g. "Jan 2021", "janv. 2021", "depuis sept. 2023"). Never convert or guess dates.
- The document may be in French or English; parse both identically and keep proper nouns (companies, institutions, certifications) verbatim.
- Respond ONLY with a JSON object matching the provided schema. No prose.`;

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
