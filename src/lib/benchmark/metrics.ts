import { franc } from "franc";
import type { MatchReport } from "@/lib/jobs/schemas";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings, SelectionRecord } from "@/lib/generation/schemas";

// --- Metric result envelope (contracts/metrics.md §Report) ---

export type MetricCategory = "deterministic" | "model_dependent";

export type MetricResult = {
  metricId: string;
  value: number | boolean;
  category: MetricCategory;
  baselineValue: number | boolean | null; // null ⇒ comparison skipped (stated reason)
  comparison: "ok" | "regressed" | "skipped";
};

export function quant4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function metric(metricId: string, value: number | boolean, category: MetricCategory): MetricResult {
  return { metricId, value, category, baselineValue: null, comparison: "skipped" };
}

// --- Metric computations (FR-005): every value derives from persisted
// artifacts; nothing here calls an LLM (FR-008). Inputs are normalized so
// ordering can never change a value (research D10). ---

const FRANC_TO_OUTPUT: Record<string, "en" | "fr" | "de"> = {
  eng: "en",
  fra: "fr",
  deu: "de",
};

/** Share of matched requirements whose evidence the final CV actually cites. */
export function computeRequirementCoverage(
  matchReport: MatchReport,
  content: GeneratedCVContent,
): { covered: number; total: number; rate: number } {
  const cited = new Set<string>();
  for (const ref of content.summaryProvenance) cited.add(ref.id);
  for (const exp of content.experience) {
    for (const b of exp.bullets) for (const id of b.sourceBulletIds) cited.add(id);
  }
  for (const edu of content.education) for (const id of edu.sourceIds) cited.add(id);
  for (const proj of content.projects) for (const b of proj.bullets) for (const id of b.sourceBulletIds) cited.add(id);
  for (const cert of content.certifications) for (const id of cert.sourceIds) cited.add(id);

  const matched = matchReport.requirements.filter((r) => r.status !== "gap" && r.evidence.length > 0);
  const covered = matched.filter((r) => r.evidence.some((e) => cited.has(e.id)));
  return {
    covered: covered.length,
    total: matched.length,
    rate: matched.length > 0 ? quant4(covered.length / matched.length) : 1,
  };
}

/** Draft ∪ omissions covers every snapshot entry (US2 scenario 5 / FR-005). */
export function computeSelectionIntegrity(
  content: GeneratedCVContent,
  selection: SelectionRecord | null,
  snapshot: PinnedSnapshot,
): boolean {
  const accounted = new Set<string>((selection?.included ?? []).map((i) => i.entryId));
  for (const o of content.omissions) accounted.add(o.id);
  const entryIds = [
    ...snapshot.experience.map((e) => e.id),
    ...snapshot.education.map((e) => e.id),
    ...snapshot.projects.map((p) => p.id),
    ...snapshot.certifications.map((c) => c.id),
  ];
  return entryIds.every((id) => accounted.has(id));
}

/** Every omission carries reason "selection" or "page_budget" (never "unwritten"). */
export function computeOmissionsReasoned(content: GeneratedCVContent): boolean {
  return content.omissions.every((o) => o.reason === "page_budget" || o.reason === "selection");
}

/** Professional summary non-empty and within the frozen summaryMaxWords bound. */
export function computeSummaryLengthOk(content: GeneratedCVContent, settings: GenerationSettings): boolean {
  const words = content.summary.trim().split(/\s+/).filter(Boolean).length;
  return words >= 1 && words <= settings.summaryMaxWords;
}

/** Final rendered page count within the frozen budget (ExtractionCheck.pages). */
export function computePageBudgetOk(
  extractionCheck: { passed?: boolean; pages?: number } | null | undefined,
  settings: GenerationSettings,
): boolean {
  return extractionCheck?.pages != null && extractionCheck.pages <= settings.pageBudget;
}

/** Generated document language matches the case's configured output language. */
export function computeOutputLanguageOk(text: string, expected: "en" | "fr" | "de"): boolean {
  return FRANC_TO_OUTPUT[franc(text)] === expected;
}

/** The shipped two-level extraction gate passed for the rendered PDF. */
export function computeExtractionGateOk(extractionCheck: { passed?: boolean } | null | undefined): boolean {
  return extractionCheck?.passed === true;
}

/** Text used for the output-language check: every human-readable string in the
 *  document, joined (deterministic order = document order). */
export function contentText(content: GeneratedCVContent): string {
  const parts: string[] = [content.summary];
  for (const exp of content.experience) {
    if (exp.title) parts.push(exp.title.text);
    for (const b of exp.bullets) parts.push(b.text);
  }
  for (const edu of content.education) parts.push(edu.text);
  for (const proj of content.projects) for (const b of proj.bullets) parts.push(b.text);
  for (const cert of content.certifications) parts.push(cert.text);
  return parts.join("\n");
}
