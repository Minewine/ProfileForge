import { z } from "zod";
import { OutputLanguageSchema, ToneSchema } from "@/lib/generation/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";

export const LETTER_ANGLES = ["motivation", "fit", "achievement"] as const;

export const GenerateCoverLetterInputSchema = z.object({
  outputLanguage: OutputLanguageSchema,
  tone: ToneSchema,
  notes: z.string().max(2000).optional(),
  paragraphs: z
    .array(
      z.object({
        key: z.string().min(1), // plan key — the model must echo it verbatim
        angle: z.enum(LETTER_ANGLES),
        evidenceText: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  cvBulletTexts: z.array(z.string()), // current CV bullets/summary — avoid repeating
  jdDigest: z.object({
    role: z.string().optional(),
    company: z.string().optional(),
    topRequirements: z.array(z.string()),
  }),
  /** Capped raw job-description text — the primary wording target. */
  jobDescription: z.string().min(1).optional(),
  maxWords: z.number().int().min(1).max(1000),
});

export const GenerateCoverLetterOutputSchema = z.object({
  paragraphs: z.array(
    z.object({
      key: z.string().min(1), // MUST be a plan key; unkeyed items are dropped (R7)
      text: z.string().min(1),
    }),
  ),
  uncertainTranslations: z.array(z.object({ key: z.string().min(1), note: z.string() })).optional(),
});

const LANGUAGE_NAMES = { fr: "French", en: "English", de: "German" } as const;

const SYSTEM_PROMPT = `You draft a cover letter from a deterministic, evidence-keyed paragraph plan.
Rules (non-negotiable):
- Zero invention: use only facts present in the provided evidence text or explicitly confirmed by the user. Do not invent metrics, tools, employers, or achievements.
- Mirror the job description: when a jobDescription is provided, phrase the letter around how the description frames the role — its priorities, vocabulary, and expectations — while stating only the candidate facts from the evidence text. Rewording only: never add facts.
- Write the whole letter in the requested output language, in the requested tone.
- Preserve employer, institution, and certification names verbatim — never translate or adapt them.
- Copy every number, date, duration, and metric exactly as it appears in the evidence text — never round, convert, or estimate.
- Complement, do not repeat: never reuse or lightly rephrase any string from the CV bullet texts you are given — add context, motivation, and connection to the job's requirements instead.
- Open the first paragraph with a salutation and close the last with a courteous closing line; do not add a handwritten-style signature.
- Stay within the max-words cap across all paragraphs combined.
- Echo each paragraph under its exact plan key. Do not add paragraphs, merge angles, or invent content for missing keys — omit a key you cannot support.
- Respond ONLY with JSON matching the schema.`;

export function ensureGenerateCoverLetterRegistered() {
  registerTask({
    name: "generateCoverLetter",
    tier: "premium",
    inputSchema: GenerateCoverLetterInputSchema,
    outputSchema: GenerateCoverLetterOutputSchema,
    buildPrompt: (payload: unknown): ChatMessage[] => {
      const input = GenerateCoverLetterInputSchema.parse(payload);
      const plan = input.paragraphs
        .map((p) => `[${p.key}] (angle: ${p.angle})\n  evidence: ${p.evidenceText.join(" | ")}`)
        .join("\n");
      const user = [
        `Output language: ${LANGUAGE_NAMES[input.outputLanguage]}`,
        `Tone: ${input.tone}`,
        input.notes ? `User notes: ${input.notes}` : null,
        `Max words total: ${input.maxWords}`,
        "",
        "Paragraph plan (write one paragraph per key):",
        plan,
        "",
        "CV bullet texts (do NOT repeat or closely rephrase these):",
        input.cvBulletTexts.length > 0 ? input.cvBulletTexts.map((s) => `- ${s}`).join("\n") : "- (none)",
        "",
        `JD digest: ${input.jdDigest.role ? `role: ${input.jdDigest.role}; ` : ""}${
          input.jdDigest.company ? `company: ${input.jdDigest.company}; ` : ""
        }requirements: ${input.jdDigest.topRequirements.join(", ") || "(none)"}`,
        ...(input.jobDescription
          ? ["", "Job description (phrase the letter around this — same facts, its framing):", input.jobDescription]
          : []),
      ]
        .filter((line) => line !== null)
        .join("\n");
      return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ];
    },
  });
}

ensureGenerateCoverLetterRegistered();
