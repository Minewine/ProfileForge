/**
 * The single definition of "normalized" for matching (Slice 2 R1): NFKD →
 * strip combining marks → lowercase → non-alphanumerics to spaces → collapse.
 * Exact matching, alias resolution, and duplicate detection all share this —
 * cross-language FR/EN equivalence (accents) is load-bearing.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
