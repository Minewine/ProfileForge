import { callLLM } from "@/lib/llm/router";
import "@/lib/llm/tasks/generatetailoredcv"; // self-registering premium task (registry pattern)
import "@/lib/llm/tasks/generatecoverletter"; // self-registering premium task (US6)
import {
  CoverLetterContentSchema,
  GeneratedCVContentSchema,
  type CoverLetterContent,
  type GeneratedCVContent,
  type GenerationSettings,
  type ValidationFlag,
} from "@/lib/generation/schemas";
import type { CVPlan, LetterPlan } from "@/lib/generation/plan";
export type { LetterPlan }; // re-exported for the letter fit/factguard/test consumers

/**
 * Stage 3 — LLM draft with the keyed merge (research R7): the premium task
 * receives plan items keyed by id and returns rephrased text per key; the merge
 * attaches provenance (`sourceBulletIds`/`summaryProvenance`) from the plan
 * itself, so provenance never passes through the model. Unkeyed output items
 * are dropped; keys the model skipped fall back to verbatim source text with a
 * `VERBATIM_FALLBACK` warning.
 */

export type TailoredCVItem = { key: string; text: string; rationale?: string };
export type TailoredCVOutput = {
  summary: string;
  items: TailoredCVItem[];
  uncertainTranslations?: Array<{ key: string; note: string }>;
};

/** Verbatim fallback text (source language) for a skipped plan item. */
export function verbatimFallbackText(sourceText: string[]): string {
  return sourceText.filter(Boolean).join(" · ");
}

function verbatimFallbackFlag(claim: string): ValidationFlag {
  return { code: "VERBATIM_FALLBACK", claim, severity: "warning", resolution: "pending" };
}

function uncertainTranslationFlag(claim: string): ValidationFlag {
  return { code: "UNCERTAIN_TRANSLATION", claim, severity: "warning", resolution: "pending" };
}

/** Pure keyed merge — deterministic, testable without the LLM. */
export function mergeKeyedDraft(
  plan: CVPlan,
  output: TailoredCVOutput,
): { content: GeneratedCVContent; warnings: ValidationFlag[] } {
  const planKeys = new Set(plan.items.map((i) => i.key));
  const byKey = new Map<string, TailoredCVItem>();
  for (const item of output.items) {
    if (planKeys.has(item.key)) byKey.set(item.key, item); // items keyed to unknown keys are dropped (R7)
  }
  const warnings: ValidationFlag[] = [];

  const experience: GeneratedCVContent["experience"] = [];
  const projects: GeneratedCVContent["projects"] = [];
  const education: GeneratedCVContent["education"] = [];
  const certifications: GeneratedCVContent["certifications"] = [];

  for (const item of plan.items) {
    const drafted = byKey.get(item.key);
    if (!drafted) warnings.push(verbatimFallbackFlag(item.key));
    const text = drafted?.text ?? verbatimFallbackText(item.sourceText);

    if (item.kind === "title") {
      // feature 005 US2: the role title is a keyed rewrite claim
      // (expTitle.{entryId}); provenance = the entry itself, sourceTitle kept
      // for the inspectable rewritten-vs-source view.
      let entry = experience.find((e) => e.id === item.entryId);
      if (!entry) {
        entry = { id: item.entryId, bullets: [] };
        experience.push(entry);
      }
      entry.title = { claimId: item.key, text, sourceTitle: item.sourceText[0] ?? text };
    } else if (item.kind === "experience") {
      let entry = experience.find((e) => e.id === item.entryId);
      if (!entry) {
        entry = { id: item.entryId, bullets: [] };
        experience.push(entry);
      }
      entry.bullets.push({
        claimId: item.key,
        text,
        sourceBulletIds: item.sourceIds,
        ...(drafted?.rationale ? { rationale: drafted.rationale } : {}),
      });
    } else if (item.kind === "project") {
      let entry = projects.find((p) => p.id === item.entryId);
      if (!entry) {
        entry = { id: item.entryId, bullets: [] };
        projects.push(entry);
      }
      entry.bullets.push({ claimId: item.key, text, sourceBulletIds: item.sourceIds });
    } else if (item.kind === "education") {
      education.push({ id: item.entryId, claimId: item.key, text, sourceIds: item.sourceIds });
    } else {
      certifications.push({ id: item.entryId, claimId: item.key, text, sourceIds: item.sourceIds });
    }
  }

  for (const uncertain of output.uncertainTranslations ?? []) {
    if (planKeys.has(uncertain.key)) warnings.push(uncertainTranslationFlag(uncertain.key));
  }

  const summary = output.summary.trim();
  const fallbackSummary = plan.summarySources[0] ?? "";
  if (!summary && fallbackSummary) warnings.push(verbatimFallbackFlag("summary"));

  const content = GeneratedCVContentSchema.parse({
    claimIdVersion: 1,
    summary: summary || fallbackSummary,
    summaryProvenance: plan.summaryEvidence,
    experience,
    education,
    projects,
    certifications,
    skills: plan.skills,
    // feature 005: the plan's selection omissions are seeded here (draft time,
    // before the fit loop) so the omissions list is complete by construction —
    // the fit loop only ever APPENDS page_budget ones.
    omissions: plan.selectionOmissions ?? [],
  });
  return { content, warnings };
}

/** Payload-minimized task input: plan items as key + source text + entry meta only. */
export function buildTaskPayload(plan: CVPlan, settings: GenerationSettings) {
  return {
    outputLanguage: settings.outputLanguage,
    ...(settings.notes ? { notes: settings.notes } : {}),
    plan: plan.items.map((i) => ({
      key: i.key,
      kind: i.kind,
      sourceText: i.sourceText,
      entryMeta: i.entryMeta,
    })),
    skills: plan.skills,
    summarySources: plan.summarySources,
    summaryRequirements: plan.summaryRequirements,
    summaryMaxWords: settings.summaryMaxWords,
    jdDigest:
      plan.jdDigest.role !== null
        ? { role: plan.jdDigest.role, keywords: plan.jdDigest.keywords }
        : { keywords: plan.jdDigest.keywords },
    ...(plan.jdText ? { jobDescription: plan.jdText } : {}),
    pageBudget: settings.pageBudget,
  };
}

/** Stage 3 runner body: call the premium task, then merge by key. */
export async function draftCV(args: {
  userId: string;
  plan: CVPlan;
  settings: GenerationSettings;
  runId: string;
  checkCancelled: () => Promise<void>;
}): Promise<{ content: GeneratedCVContent; warnings: ValidationFlag[] }> {
  if (args.plan.items.length === 0) {
    // Nothing claim-worthy in the pinned snapshot — skip the LLM call entirely.
    return mergeKeyedDraft(args.plan, { summary: "", items: [] });
  }
  await args.checkCancelled(); // cancelRequested is checked before every LLM call
  const result = await callLLM<TailoredCVOutput>({
    userId: args.userId,
    task: "generateTailoredCV",
    payload: buildTaskPayload(args.plan, args.settings),
    runId: args.runId,
  });
  return mergeKeyedDraft(args.plan, result.data);
}

// --- Cover letter (US6, contracts/llm-tasks.md generateCoverLetter) ---

export type CoverLetterDraftItem = { key: string; text: string };
export type CoverLetterOutput = {
  paragraphs: CoverLetterDraftItem[];
  uncertainTranslations?: Array<{ key: string; note: string }>;
};

/** Pure keyed merge for the letter — the R7 anti-invention rules plus the
 *  letter contract (llm-tasks.md): unkeyed paragraphs are dropped and keys the
 *  model skipped are OMITTED with an omission entry (a letter never shows
 *  verbatim-fallback text; the fit loop's page_budget omissions join these). */
export function mergeKeyedLetterDraft(
  plan: LetterPlan,
  output: CoverLetterOutput,
  tone: string = "professional",
): { content: CoverLetterContent; warnings: ValidationFlag[] } {
  const planKeys = new Set(plan.items.map((i) => i.key));
  const byKey = new Map<string, CoverLetterDraftItem>();
  for (const paragraph of output.paragraphs) {
    if (planKeys.has(paragraph.key)) byKey.set(paragraph.key, paragraph);
  }
  const warnings: ValidationFlag[] = [];

  const paragraphs: CoverLetterContent["paragraphs"] = [];
  const omissions: CoverLetterContent["omissions"] = [];
  for (const item of plan.items) {
    const drafted = byKey.get(item.key);
    if (!drafted) {
      // skipped angle → omitted with an entry, never invented or padded
      omissions.push({ type: "letter_paragraph", id: item.key, reason: "unwritten" });
      continue;
    }
    paragraphs.push({ claimId: item.key, text: drafted.text, evidence: item.evidence });
  }

  for (const uncertain of output.uncertainTranslations ?? []) {
    if (planKeys.has(uncertain.key)) warnings.push(uncertainTranslationFlag(uncertain.key));
  }

  const content = CoverLetterContentSchema.parse({
    claimIdVersion: 1,
    paragraphs,
    tone,
    omissions,
  });
  return { content, warnings };
}

/** Payload-minimized letter task input (tone + language + anti-repetition texts). */
export function buildLetterTaskPayload(
  plan: LetterPlan,
  settings: GenerationSettings,
  cvBulletTexts: string[],
) {
  return {
    outputLanguage: settings.outputLanguage,
    tone: settings.tone,
    ...(settings.notes ? { notes: settings.notes } : {}),
    paragraphs: plan.items.map((i) => ({ key: i.key, angle: i.angle, evidenceText: i.sourceText })),
    cvBulletTexts,
    // role: null would fail the task's `z.string().optional()` schema — omit it
    // like the CV payload does (P0 review finding: null ≠ absent for zod).
    jdDigest: {
      ...(plan.jdDigest.role !== null ? { role: plan.jdDigest.role } : {}),
      keywords: plan.jdDigest.keywords,
      topRequirements: plan.jdDigest.topRequirements,
    },
    ...(plan.jdText ? { jobDescription: plan.jdText } : {}),
    maxWords: plan.maxWords,
  };
}

/** Stage 3 runner body for letters: call the premium task, then merge by key. */
export async function draftLetter(args: {
  userId: string;
  plan: LetterPlan;
  settings: GenerationSettings;
  cvTexts: string[];
  runId: string;
  checkCancelled: () => Promise<void>;
}): Promise<{ content: CoverLetterContent; warnings: ValidationFlag[] }> {
  if (args.plan.items.length === 0) {
    return mergeKeyedLetterDraft(args.plan, { paragraphs: [] }, args.settings.tone);
  }
  await args.checkCancelled(); // cancelRequested is checked before every LLM call
  const result = await callLLM<CoverLetterOutput>({
    userId: args.userId,
    task: "generateCoverLetter",
    payload: buildLetterTaskPayload(args.plan, args.settings, args.cvTexts),
    runId: args.runId,
  });
  return mergeKeyedLetterDraft(args.plan, result.data, args.settings.tone);
}
