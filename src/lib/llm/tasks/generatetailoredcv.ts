import { z } from "zod";
import { OutputLanguageSchema } from "@/lib/generation/schemas";
import { registerTask, type ChatMessage } from "@/lib/llm/router";
import { loadSystemPrompt } from "@/lib/llm/prompts/load";

export const PLAN_ITEM_KINDS = ["experience", "project", "education", "certification", "title"] as const;

export const GenerateTailoredCVInputSchema = z.object({
  outputLanguage: OutputLanguageSchema,
  notes: z.string().max(2000).optional(),
  plan: z
    .array(
      z.object({
        key: z.string().min(1), // plan key — the model must echo it verbatim
        kind: z.enum(PLAN_ITEM_KINDS),
        sourceText: z.array(z.string().min(1)).min(1),
        entryMeta: z.object({ title: z.string(), company: z.string(), dates: z.string() }),
      }),
    )
    .min(1),
  skills: z.array(z.string()), // deterministic — passthrough only, never extended
  summarySources: z.array(z.string()),
  summaryRequirements: z.array(z.string()).max(5), // JD must-haves the summary connects evidence to (US3; may be empty)
  summaryMaxWords: z.number().int().min(30).max(120), // user-facing length bound (US3)
  jdDigest: z.object({ role: z.string().optional(), company: z.string().optional(), keywords: z.array(z.string()) }),
  /** Capped raw job-description text — the primary wording target. */
  jobDescription: z.string().min(1).optional(),
  pageBudget: z.number().int().min(1).max(3),
});

export const GenerateTailoredCVOutputSchema = z.object({
  summary: z.string(), // output-language, evidence-aware, ≤ summaryMaxWords (US3)
  items: z.array(
    z.object({
      key: z.string().min(1), // MUST be a plan key; unkeyed items are dropped (R7)
      text: z.string().min(1), // rephrased/tightened/translated source text
      rationale: z.string().max(140).optional(),
    }),
  ),
  uncertainTranslations: z.array(z.object({ key: z.string().min(1), note: z.string() })).optional(),
});

const LANGUAGE_NAMES = { fr: "French", en: "English", de: "German" } as const;

// Loaded at import (= registration) time so a missing/empty prompt file fails
// startup. The {summaryMaxWords} placeholder is substituted per request below.
const SYSTEM_PROMPT_TEMPLATE = loadSystemPrompt("generateTailoredCV.md");

export function ensureGenerateTailoredCVRegistered() {
  registerTask({
    name: "generateTailoredCV",
    tier: "premium",
    inputSchema: GenerateTailoredCVInputSchema,
    outputSchema: GenerateTailoredCVOutputSchema,
    buildPrompt: (payload: unknown): ChatMessage[] => {
      const input = GenerateTailoredCVInputSchema.parse(payload);
      const items = input.plan
        .map(
          (i) =>
            `[${i.key}] (${i.kind}) ${i.entryMeta.title} · ${i.entryMeta.company} · ${i.entryMeta.dates}\n  source: ${i.sourceText.join(" | ")}`,
        )
        .join("\n");
      const user = [
        `Output language: ${LANGUAGE_NAMES[input.outputLanguage]}`,
        input.notes ? `User notes: ${input.notes}` : null,
        `Page budget: ${input.pageBudget} page(s)`,
        "",
        "Plan items (rewrite each under its key):",
        items,
        "",
        "Summary requirement areas (foreground the strongest evidence for each):",
        input.summaryRequirements.length > 0
          ? input.summaryRequirements.map((s) => `- ${s}`).join("\n")
          : "- (none — write it from the strongest evidence alone)",
        "",
        `Summary source texts (write the at-most-${input.summaryMaxWords}-word summary from these, connecting it to the requirement areas above):`,
        input.summarySources.length > 0 ? input.summarySources.map((s) => `- ${s}`).join("\n") : "- (none)",
        "",
        `Skills (deterministic — echo verbatim, never extend): ${input.skills.join(", ") || "(none)"}`,
        `JD digest: ${input.jdDigest.role ? `role: ${input.jdDigest.role}; ` : ""}${
          input.jdDigest.company ? `company: ${input.jdDigest.company}; ` : ""
        }keywords: ${input.jdDigest.keywords.join(", ") || "(none)"}`,
        ...(input.jobDescription
          ? ["", "Job description (reword the summary and item text toward this — same facts, its wording):", input.jobDescription]
          : []),
      ]
        .filter((line) => line !== null)
        .join("\n");
      return [
        { role: "system", content: SYSTEM_PROMPT_TEMPLATE.replaceAll("{summaryMaxWords}", String(input.summaryMaxWords)) },
        { role: "user", content: user },
      ];
    },
  });
}

ensureGenerateTailoredCVRegistered();
