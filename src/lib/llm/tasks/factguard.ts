import { z } from "zod";
import { OutputLanguageSchema } from "@/lib/generation/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";

/**
 * Economy-tier Fact Guard task (contracts/llm-tasks.md): per-claim
 * meaning-preservation verdicts between the drafted text and its cited
 * evidence. The deterministic layer runs first and resolves the evidence —
 * this task only judges meaning, never provenance.
 */

export const FACT_GUARD_VERDICTS = ["supported", "drifted", "unsupported"] as const;
export type FactGuardVerdict = (typeof FACT_GUARD_VERDICTS)[number];

export const FactGuardInputSchema = z.object({
  outputLanguage: OutputLanguageSchema,
  claims: z
    .array(
      z.object({
        claimId: z.string().min(1),
        text: z.string().min(1),
        evidenceText: z.array(z.string()).min(1), // resolved against the pinned snapshot
      }),
    )
    .min(1),
});

export const FactGuardOutputSchema = z.object({
  verdicts: z.array(
    z.object({
      claimId: z.string().min(1),
      verdict: z.enum(FACT_GUARD_VERDICTS),
      note: z.string().max(140).optional(), // what changed / what's missing
    }),
  ),
});

const LANGUAGE_NAMES = { fr: "French", en: "English", de: "German" } as const;

const SYSTEM_PROMPT = `You judge meaning preservation between drafted CV claims and their cited evidence.
Rules (non-negotiable):
- Judge ONLY whether the claim's meaning is supported by the evidence text. Ignore style and tone.
- Rephrasing, tightening, translation, and reordering are "supported".
- Changed scope, inflated impact, weakened hedges, or added/changed facts are "drifted".
- When nothing in the evidence supports the claim, the verdict is "unsupported".
- Use only facts present in the provided evidence — do not invent metrics, tools, employers, or achievements.
- Every claimId in the input must appear exactly once in your output — never skip a claim, never invent one.
- note (optional, ≤140 chars) says what changed or what is missing.
- Respond ONLY with JSON matching the schema.`;

export function ensureFactGuardRegistered() {
  registerTask({
    name: "factGuard",
    tier: "economy",
    inputSchema: FactGuardInputSchema,
    outputSchema: FactGuardOutputSchema,
    buildPrompt: (payload: unknown): ChatMessage[] => {
      const input = FactGuardInputSchema.parse(payload);
      const claims = input.claims
        .map((c) => `[${c.claimId}]\n  claim: ${c.text}\n  evidence: ${c.evidenceText.join(" | ")}`)
        .join("\n");
      return [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Output language: ${LANGUAGE_NAMES[input.outputLanguage]}\n\nClaims to judge:\n${claims}`,
        },
      ];
    },
  });
}

ensureFactGuardRegistered();
