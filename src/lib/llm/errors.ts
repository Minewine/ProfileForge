import { ApiError, redact, type ErrorCode } from "@/lib/api/errors";

/**
 * Maps OpenRouter HTTP statuses to actionable error codes (contracts/llm-router.md).
 * Unmapped statuses are no longer collapsed into one generic message (the GUI test
 * run's P1: a retired model's HTTP 404 surfaced as "temporarily unavailable") — the
 * message names the status and, when available, a short redacted provider detail,
 * so the user sees WHY and can act (usually: switch model in Settings).
 */
export function mapOpenRouterStatus(status: number, providerDetail?: string): ApiError {
  const table: Record<number, [ErrorCode, string]> = {
    401: ["LLM_KEY_INVALID", "The OpenRouter key was rejected. Check the key in Settings."],
    403: ["LLM_KEY_INVALID", "The OpenRouter key is not permitted for this model. Check the key in Settings."],
    402: [
      "LLM_QUOTA",
      "OpenRouter credit is exhausted — paid models cannot run until you top up. Top up credit or switch to a free model in Settings.",
    ],
    429: ["LLM_RATE_LIMITED", "Rate limited by OpenRouter. Wait a moment and retry."],
  };
  const mapped = table[status];
  if (mapped) return new ApiError(mapped[0], mapped[1]);
  const detail = providerDetail ? ` Provider said: ${redact(providerDetail.slice(0, 200))}` : "";
  if (status === 404) {
    return new ApiError(
      "LLM_UNAVAILABLE",
      "The configured model was not found on OpenRouter (wrong model id, or the model was retired). Pick another model in Settings." +
        detail,
    );
  }
  return new ApiError(
    "LLM_UNAVAILABLE",
    `The AI provider returned HTTP ${status}. Please retry — your work so far is preserved; if it persists, check the selected model in Settings.` +
      detail,
  );
}
