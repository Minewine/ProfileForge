/**
 * Shared client-safe message maps (feature 006, research R6): action pointers
 * for AI/pipeline failure codes and one-sentence explanations for Fact Guard
 * flag kinds. Pure data + string functions, ZERO imports — safe for client
 * components (the no-`node:`-imports convention documented in
 * GenerationPanel.tsx). Server message text stays the single source of truth;
 * these maps add only the *what to do next* layer, keyed by code.
 *
 * Contracts: specs/006-polish-reliability/contracts/error-messages.md,
 * specs/006-polish-reliability/contracts/fact-guard-ux.md
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

/** One-sentence, plain-language explanations per flag kind (Fact Guard UX).
 *  Inventory = exactly the ValidationFlag codes emitted by the generation
 *  Fact Guard + draft merge (SKILL_UNVERIFIED included; INCONSISTENT_STATE is
 *  a profile-claims code, not a generation flag — deliberately absent). */
export const FLAG_EXPLANATIONS: Record<string, string> = {
  NUMERIC_MISMATCH: "A number in this claim doesn't match your profile evidence — fix it or confirm the correct figure.",
  MEANING_DRIFT:
    "This claim appears to say more than your profile evidence supports — tighten it, remove it, or confirm it's accurate.",
  UNSUPPORTED_CLAIM: "Your profile has no evidence backing this claim — add evidence in the profile, remove it, or confirm it.",
  DANGLING_PROVENANCE: "This claim points to profile content that no longer exists — re-match the job, edit the claim, or remove it.",
  LETTER_DUPLICATES_CV: "This sentence repeats your CV almost word for word — rephrase it in the letter.",
  SKILL_UNVERIFIED:
    "This skill isn't in your profile or the matched requirements — add it to the profile or re-run the match, then regenerate.",
  VERBATIM_FALLBACK:
    "The AI didn't rewrite this item, so the original source wording is used (it may not match the output language) — edit it or regenerate.",
  UNCERTAIN_TRANSLATION: "The AI wasn't sure about this translation — double-check the wording.",
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
