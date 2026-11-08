import { normalizeForContainment } from "@/lib/validation/sourceContainment";

/**
 * Deterministic grounding check on LLM-rewritten claims (warnings-only successor
 * to the removed Fact Guard): numbers and all-caps acronyms in the rewrite must
 * appear in the claim's sanctioned sources — exactly the texts the prompt
 * receives as claim-relevant input (plan sourceText + entryMeta; summary/letter
 * digest fields), never the free-form job description. Comparison uses the same
 * case-, accent-, and punctuation-insensitive normalization as the ingestion
 * containment gate.
 *
 * Capitalized words and multi-word name phrases are deliberately NOT checked:
 * the rewrite may switch output language (FR/EN/DE) and feature 005 rewrites
 * role titles per language by design, so a dictionary-less entity rule cannot
 * separate translated phrases ("Informatique" → "Computer Science", guaranteed
 * false positives) from invented names. Word-form numbers ("five") and
 * multiplier suffixes are grounded via their digit run ("1.5x" vs source
 * "1.5"). Warn-only: violations never gate downloads.
 */

export type GroundingViolation = { kind: "number" | "acronym"; token: string };

const TOKEN_SEP = /[^\p{L}\p{N}]+/u;
const SENTENCE_SEP = /[.!?;:•·\n\u2022]+/u;

export function checkGrounding(text: string, sanctioned: string[]): GroundingViolation[] {
  const allowed = new Set(sanctioned.flatMap((s) => normalizeForContainment(s)));
  const violations: GroundingViolation[] = [];
  const seen = new Set<string>();
  const flag = (kind: GroundingViolation["kind"], token: string) => {
    const normalized = normalizeForContainment(token).join(" ");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    violations.push({ kind, token });
  };
  const grounded = (token: string): boolean => {
    if (allowed.has(normalizeForContainment(token).join(" "))) return true;
    // number formatting variants: "5x", "200M" ground via their digit run
    const digits = token.match(/^\p{N}+/u)?.[0];
    return digits !== undefined && digits !== token && allowed.has(digits);
  };

  for (const segment of text.split(SENTENCE_SEP)) {
    for (const token of segment.split(TOKEN_SEP).filter(Boolean)) {
      if (/\p{N}/u.test(token) && !grounded(token)) flag("number", token);
      if (token.length >= 2 && /^\p{Lu}+$/u.test(token) && !grounded(token)) flag("acronym", token);
    }
  }
  return violations;
}
