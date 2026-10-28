import { franc } from "franc";

export type LanguageDetection = { language: "fr" | "en"; confident: boolean };

/**
 * Deterministic FR/EN detection (R3) — no LLM, no cost, reproducible.
 * Short or unrecognized text returns a default with confident=false so the
 * UI always offers correction (FR-030).
 */
export function detectLanguage(text: string): LanguageDetection {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < 80) return { language: "en", confident: false };
  const code = franc(clean, { minLength: 80 });
  if (code === "fra") return { language: "fr", confident: true };
  if (code === "eng") return { language: "en", confident: true };
  return { language: "en", confident: false };
}
