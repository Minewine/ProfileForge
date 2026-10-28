/**
 * Zero-invention enforcement at ingestion (R8): every parsed bullet/material
 * field must be grounded in the extracted source text — ≥95% word-level
 * recovery under case-, accent-, and punctuation-insensitive normalization
 * (mirrors FR-021's comparison rules).
 */

export function normalizeForContainment(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export type ContainmentResult = { ok: boolean; ratio: number };

export function checkContainment(claim: string, sourceText: string): ContainmentResult {
  const claimTokens = normalizeForContainment(claim);
  if (claimTokens.length === 0) return { ok: true, ratio: 1 };
  const sourceTokens = new Set(normalizeForContainment(sourceText));
  const present = claimTokens.filter((t) => sourceTokens.has(t)).length;
  const ratio = present / claimTokens.length;
  return { ok: ratio >= 0.95, ratio };
}

export function checkContainmentBulk(claims: string[], sourceText: string): ContainmentResult[] {
  return claims.map((c) => checkContainment(c, sourceText));
}
