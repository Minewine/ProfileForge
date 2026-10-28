import { ApiError, type ErrorCode } from "@/lib/api/errors";

/** Maps OpenRouter HTTP statuses to actionable error codes (contracts/llm-router.md). */
export function mapOpenRouterStatus(status: number): ApiError {
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
  return new ApiError(
    "LLM_UNAVAILABLE",
    "The AI provider is temporarily unavailable. Please retry — your work so far is preserved.",
  );
}
