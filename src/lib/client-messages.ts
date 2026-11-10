/**
 * Shared client-safe message maps (feature 006, research R6): action pointers
 * for AI/pipeline failure codes and one-sentence explanations for draft warning
 * codes. Pure data + string functions, ZERO imports — safe for client
 * components (the no-`node:`-imports convention documented in
 * GenerationPanel.tsx). Server message text stays the single source of truth;
 * these maps add only the *what to do next* layer, keyed by code.
 *
 * Contract: specs/006-polish-reliability/contracts/error-messages.md
 * (tests/unit/client-messages.test.ts guards completeness — a new code without
 * an entry here fails CI).
 */

export const LLM_ERROR_GUIDANCE: Record<string, string> = {
  LLM_KEY_INVALID: "Open Settings to update the key.",
  LLM_QUOTA: "Top up OpenRouter credit or switch to a free model in Settings.",
  LLM_RATE_LIMITED: "Retry in a moment.",
  LLM_UNAVAILABLE: "Retry; if it persists, check the selected model in Settings.",
  LLM_SCHEMA_REPAIR_FAILED: "Retry or switch models in Settings.",
};

/** Generation-job failure action pointers (`statusError` codes). */
const JOB_ERROR_GUIDANCE: Record<string, string> = {
  PAGE_BUDGET_CONFLICT: "Raise the page budget, un-restore items, or regenerate.",
  EXPORT_GATE_FAILED: "Regenerate to retry the export.",
};

/** One-sentence, plain-language explanations per draft warning kind.
 *  Inventory = exactly the ValidationFlag codes emitted by the draft merge
 *  since the Fact Guard removal (warnings only). */
export const FLAG_EXPLANATIONS: Record<string, string> = {
  VERBATIM_FALLBACK:
    "The AI didn't rewrite this item, so the original source wording is used (it may not match the output language) — edit it or regenerate.",
  UNCERTAIN_TRANSLATION: "The AI wasn't sure about this translation — double-check the wording.",
  GROUNDING_FAILED:
    "The AI's rewrite may have added a detail that isn't in the source evidence — double-check it or regenerate.",
};

/** One-sentence, plain-language explanation per grounding level — the helper
 *  line under the generation panel's grounding select. Keys mirror
 *  GroundingLevelSchema (src/lib/generation/schemas.ts) inline: this file must
 *  stay zero-import, and the prompt-side directives for the non-strict levels
 *  live in src/lib/llm/prompts/groundingLevels.ts — keep the two in sync. */
export const GROUNDING_LEVEL_EXPLANATIONS: Record<"strict" | "polished" | "embellished", string> = {
  strict: "The AI only rephrases and translates what is already in your profile — nothing is added beyond it.",
  polished:
    "The AI writes more assertively with stronger verbs, while every fact, number, and name still comes from your evidence; anything flagged as unsupported still shows up as a warning.",
  embellished:
    "On top of the polished wording, the AI may add plausible qualitative color around your real experience — but never employers, titles, dates, credentials, technologies, numbers, or new names, and flagged unsupported details still surface as warnings.",
};

const guidanceFor = (code: string): string | null =>
  LLM_ERROR_GUIDANCE[code] ?? JOB_ERROR_GUIDANCE[code] ?? null;

export type DescribedError = {
  /** The machine code (from the envelope, or the `statusError` prefix); null when absent. */
  code: string | null;
  /** The server-provided cause text — rendered verbatim, never rewritten here. */
  message: string;
  /** The client action pointer; null for unknown codes (guidance is never invented). */
  action: string | null;
};

/** Describe a failure for display from either an envelope (`code` + `message`)
 *  or a raw job `statusError` (`"CODE: message"` — split on the first `": "`). */
export function describeError(codeOrStatusError: string, message?: string): DescribedError {
  if (message !== undefined) {
    return { code: codeOrStatusError, message, action: guidanceFor(codeOrStatusError) };
  }
  const separator = codeOrStatusError.indexOf(": ");
  if (separator === -1) {
    return { code: null, message: codeOrStatusError, action: null };
  }
  const code = codeOrStatusError.slice(0, separator);
  return { code, message: codeOrStatusError.slice(separator + 2), action: guidanceFor(code) };
}
