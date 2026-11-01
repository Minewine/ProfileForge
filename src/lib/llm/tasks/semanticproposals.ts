import { z } from "zod";
import { LanguageCodeSchema } from "@/lib/validation/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";
import { loadSystemPrompt } from "@/lib/llm/prompts/load";

export const SemanticProposalsInputSchema = z.object({
  language: LanguageCodeSchema,
  requirements: z
    .array(z.object({ index: z.number().int().min(0), text: z.string().min(1).max(500) }))
    .min(1),
  profileDigest: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["skill", "bullet", "education", "certification"]),
        text: z.string(),
      }),
    )
    .min(1),
});

export const SemanticProposalsOutputSchema = z.object({
  proposals: z
    .array(
      z.object({
        requirementIndex: z.number().int().min(0),
        entryIds: z.array(z.string()).max(10),
        rationale: z.string().max(200).optional(),
      }),
    )
    .max(100),
});

// Loaded at import (= registration) time so a missing/empty prompt file fails startup.
const SYSTEM_PROMPT = loadSystemPrompt("semanticProposals.md");

export function ensureSemanticProposalsRegistered() {
  registerTask({
    name: "semanticProposals",
    tier: "economy",
    inputSchema: SemanticProposalsInputSchema,
    outputSchema: SemanticProposalsOutputSchema,
    buildPrompt: (payload: unknown): ChatMessage[] => {
      const input = SemanticProposalsInputSchema.parse(payload);
      const digest = input.profileDigest.map((e) => `[${e.id}] (${e.type}) ${e.text}`).join("\n");
      const reqs = input.requirements.map((r) => `#${r.index}: ${r.text}`).join("\n");
      return [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Requirements (language: ${input.language}):\n${reqs}\n\nProfile digest:\n${digest}`,
        },
      ];
    },
  });
}

ensureSemanticProposalsRegistered();
