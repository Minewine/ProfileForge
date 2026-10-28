import { z } from "zod";
import { LanguageCodeSchema } from "@/lib/validation/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";

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

const SYSTEM_PROMPT = `You match job requirements against a candidate's profile digest.
Rules (non-negotiable):
- Propose a match ONLY where the cited profile entries genuinely demonstrate the requirement.
- Cite EXACT entry IDs from the digest — never invent IDs.
- If nothing genuinely matches a requirement, return no proposal for it. A missing proposal is a better answer than a wrong one.
- rationale (optional, ≤200 chars) explains the link; it is display-only.
- Respond ONLY with JSON matching the schema.`;

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
