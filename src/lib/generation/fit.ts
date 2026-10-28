import { ApiError } from "@/lib/api/errors";
import type { CVPlan, LetterPlan } from "@/lib/generation/plan";
import type {
  CoverLetterContent,
  GeneratedCVContent,
  GenerationSettings,
  Omission,
} from "@/lib/generation/schemas";
import { renderCVForSettings } from "@/lib/generation/render/dispatch";
import { renderLetter } from "@/lib/generation/render/letter";
import { normalizeText } from "@/lib/text/normalize";

/**
 * Stage 5 — measure-and-demote page-budget fitting (FR-003, research R9):
 * render → count pages (pdf-lib measures exactly) → while over budget, demote
 * the lowest-scored demotable unit into `content.omissions` with reason
 * `page_budget` → re-render. Whole entries demote before their bullets; no
 * fixed quotas anywhere. Restored omissions (must-include) never demote — a
 * pre-check fails `PAGE_BUDGET_CONFLICT` early when they alone cannot fit
 * (SC-006: explicit, never silent).
 */

export type FitOutcome = {
  /** The fitted content — omissions final; THIS is what the version persists. */
  content: GeneratedCVContent;
  bytes: Uint8Array;
  pageCount: number;
  /** Render passes used (1 + one per demotion) — observability for the loop. */
  renders: number;
};

const PAGE_BUDGET_REASON = "page_budget";

function budgetConflict(message: string): ApiError {
  return new ApiError("PAGE_BUDGET_CONFLICT", message);
}

// --- Demotable units ---

type Unit =
  | { kind: "experience_entry"; entryId: string; score: number }
  | { kind: "experience_bullet"; entryId: string; claimId: string; score: number }
  | { kind: "project_entry"; entryId: string; score: number }
  | { kind: "project_bullet"; entryId: string; claimId: string; score: number }
  | { kind: "education"; claimId: string; score: number }
  | { kind: "certification"; claimId: string; score: number };

/** Item/entry scores from the plan (stage 2) — demotion order falls out of the
 *  same ranking, so "strongest evidence survives" holds by construction. */
function planScores(plan: CVPlan): {
  entryScore: Map<string, number>;
  itemScore: Map<string, number>; // by claim key
  must: Set<string>; // claim keys exempt from demotion
  mustSkills: Set<string>; // normalized skill names exempt from Tier-3 demotion (US5)
} {
  const entryScore = new Map<string, number>();
  const itemScore = new Map<string, number>();
  const must = new Set<string>();
  for (const item of plan.items) {
    entryScore.set(item.entryId, item.entryScore);
    itemScore.set(item.key, item.score);
    if (item.mustInclude) must.add(item.key);
  }
  const mustSkills = new Set((plan.mustIncludeSkills ?? []).map((s) => normalizeText(s)));
  return { entryScore, itemScore, must, mustSkills };
}

/** The lowest-scored demotable unit under the tiered rule: whole entries
 *  first, then individual bullets/education/certifications, then skills.
 *  Null when nothing demotable remains. */
function nextDemotion(
  content: GeneratedCVContent,
  scores: ReturnType<typeof planScores>,
): Unit | { kind: "skill"; skill: string } | null {
  // Tier 1 — whole entries (a must-include bullet anywhere protects the entry)
  const wholeEntries: Array<{ kind: "experience_entry" | "project_entry"; entryId: string; score: number }> = [];
  for (const entry of content.experience) {
    if (entry.bullets.length > 0 && !entry.bullets.some((b) => scores.must.has(b.claimId))) {
      wholeEntries.push({ kind: "experience_entry", entryId: entry.id, score: scores.entryScore.get(entry.id) ?? 0 });
    }
  }
  for (const project of content.projects) {
    if (project.bullets.length > 0 && !project.bullets.some((b) => scores.must.has(b.claimId))) {
      wholeEntries.push({ kind: "project_entry", entryId: project.id, score: scores.entryScore.get(project.id) ?? 0 });
    }
  }
  const pick = <T extends { score: number }>(items: T[]): T | null =>
    items.length === 0
      ? null
      : items.reduce((lowest, item) => (item.score < lowest.score ? item : lowest)); // ties → first (stable)

  const whole = pick(wholeEntries);
  if (whole) return whole;

  // Tier 2 — item-level units (bullets, education, certifications)
  const items: Unit[] = [];
  for (const entry of content.experience) {
    for (const bullet of entry.bullets) {
      if (!scores.must.has(bullet.claimId)) {
        items.push({ kind: "experience_bullet", entryId: entry.id, claimId: bullet.claimId, score: scores.itemScore.get(bullet.claimId) ?? 0 });
      }
    }
  }
  for (const project of content.projects) {
    for (const bullet of project.bullets) {
      if (!scores.must.has(bullet.claimId)) {
        items.push({ kind: "project_bullet", entryId: project.id, claimId: bullet.claimId, score: scores.itemScore.get(bullet.claimId) ?? 0 });
      }
    }
  }
  for (const education of content.education) {
    if (!scores.must.has(education.claimId)) {
      items.push({ kind: "education", claimId: education.claimId, score: scores.itemScore.get(education.claimId) ?? 0 });
    }
  }
  for (const certification of content.certifications) {
    if (!scores.must.has(certification.claimId)) {
      items.push({ kind: "certification", claimId: certification.claimId, score: scores.itemScore.get(certification.claimId) ?? 0 });
    }
  }
  const unit = pick(items);
  if (unit) return unit;

  // Tier 3 — skills, least-important last (skills are importance-ordered);
  // restored skill omissions are must-include and never demote (SC-006)
  const demotableSkills = content.skills.filter((s) => !scores.mustSkills.has(normalizeText(s)));
  if (demotableSkills.length > 0) return { kind: "skill", skill: demotableSkills[demotableSkills.length - 1] };
  return null;
}

/** Apply one demotion: remove the unit from the content and record the omission. */
function applyDemotion(content: GeneratedCVContent, unit: Unit | { kind: "skill"; skill: string }): GeneratedCVContent {
  const omission = (type: string, id: string): Omission => ({ type, id, reason: PAGE_BUDGET_REASON });
  switch (unit.kind) {
    case "experience_entry":
      return {
        ...content,
        experience: content.experience.filter((e) => e.id !== unit.entryId),
        omissions: [...content.omissions, omission("experience", unit.entryId)],
      };
    case "project_entry":
      return {
        ...content,
        projects: content.projects.filter((p) => p.id !== unit.entryId),
        omissions: [...content.omissions, omission("project", unit.entryId)],
      };
    case "experience_bullet":
      return {
        ...content,
        experience: content.experience
          .map((e) => (e.id === unit.entryId ? { ...e, bullets: e.bullets.filter((b) => b.claimId !== unit.claimId) } : e))
          .filter((e) => e.bullets.length > 0), // no empty sections
        omissions: [...content.omissions, omission("experience_bullet", unit.claimId)],
      };
    case "project_bullet":
      return {
        ...content,
        projects: content.projects
          .map((p) => (p.id === unit.entryId ? { ...p, bullets: p.bullets.filter((b) => b.claimId !== unit.claimId) } : p))
          .filter((p) => p.bullets.length > 0),
        omissions: [...content.omissions, omission("project_bullet", unit.claimId)],
      };
    case "education":
      return {
        ...content,
        education: content.education.filter((e) => e.claimId !== unit.claimId),
        omissions: [...content.omissions, omission("education", unit.claimId)],
      };
    case "certification":
      return {
        ...content,
        certifications: content.certifications.filter((c) => c.claimId !== unit.claimId),
        omissions: [...content.omissions, omission("certification", unit.claimId)],
      };
    case "skill":
      return {
        ...content,
        // remove the picked skill by value — the Tier-3 picker skips must-include
        // skills, so the array's last element is not necessarily the one demoted
        skills: content.skills.filter((s) => s !== unit.skill),
        omissions: [...content.omissions, omission("skill", unit.skill)],
      };
  }
}

/** Content restricted to the must-include set (summary and basics are never
 *  demotable, so they stay) — the pre-check's conservative render input. */
function restrictToMust(
  content: GeneratedCVContent,
  must: Set<string>,
  mustSkills: Set<string>,
): GeneratedCVContent {
  const keepBullets = <B extends { claimId: string }>(bullets: B[]): B[] =>
    bullets.filter((b) => must.has(b.claimId));
  return {
    ...content,
    experience: content.experience
      .map((e) => ({ ...e, bullets: keepBullets(e.bullets) }))
      .filter((e) => e.bullets.length > 0),
    projects: content.projects
      .map((p) => ({ ...p, bullets: keepBullets(p.bullets) }))
      .filter((p) => p.bullets.length > 0),
    education: content.education.filter((e) => must.has(e.claimId)),
    certifications: content.certifications.filter((c) => must.has(c.claimId)),
    skills: content.skills.filter((s) => mustSkills.has(normalizeText(s))), // restored skills only
  };
}

/** Fit the drafted content into `settings.pageBudget`. Throws
 *  `PAGE_BUDGET_CONFLICT` when the must-include set alone exceeds the budget
 *  (pre-check) or when nothing demotable remains while still over budget. */
export async function fitCVToBudget(args: {
  content: GeneratedCVContent;
  plan: CVPlan;
  snapshot: Parameters<typeof renderCVForSettings>[0]["snapshot"];
  settings: GenerationSettings;
  sanitize?: (text: string) => string;
}): Promise<FitOutcome> {
  const { content, plan, snapshot, settings } = args;
  const scores = planScores(plan);

  if (scores.must.size > 0 || scores.mustSkills.size > 0) {
    // R9 pre-check: exact render of the must-include set (conservative — the
    // real layout, nothing estimated), fail fast with guidance instead of a
    // post-draft surprise.
    const pre = await renderCVForSettings({
      content: restrictToMust(content, scores.must, scores.mustSkills),
      snapshot,
      settings,
      ...(args.sanitize ? { sanitize: args.sanitize } : {}),
    });
    if (pre.pageCount > settings.pageBudget) {
      throw budgetConflict(
        `The must-include content alone needs ${pre.pageCount} pages but the budget is ${settings.pageBudget}. ` +
          "Raise the page budget or trim the must-include items (restored omissions).",
      );
    }
  }

  let current = content;
  let render = await renderCVForSettings({
    content: current,
    snapshot,
    settings,
    ...(args.sanitize ? { sanitize: args.sanitize } : {}),
  });
  let renders = 1;

  while (render.pageCount > settings.pageBudget) {
    const unit = nextDemotion(current, scores);
    if (!unit) {
      throw budgetConflict(
        `The content needs ${render.pageCount} pages but the budget is ${settings.pageBudget} and nothing ` +
          "demotable remains (must-include items and the summary cannot be omitted). Raise the page budget or trim the profile.",
      );
    }
    current = applyDemotion(current, unit);
    render = await renderCVForSettings({
      content: current,
      snapshot,
      settings,
      ...(args.sanitize ? { sanitize: args.sanitize } : {}),
    });
    renders += 1;
  }

  return { content: current, bytes: render.bytes, pageCount: render.pageCount, renders };
}

// --- Letter fitting (US6, research R11): fixed 1-page budget, paragraphs as
// the demotion unit, plan scores drive the order (motivation first) ---

export type LetterFitOutcome = {
  content: CoverLetterContent;
  bytes: Uint8Array;
  pageCount: number;
  renders: number;
};

/** Fit the drafted letter onto its fixed single page. Demotes the lowest-scored
 *  plan paragraph while over budget; when only one paragraph remains and the
 *  letter still overflows, fails `PAGE_BUDGET_CONFLICT` — an empty letter is
 *  not a deliverable. */
export async function fitLetterToBudget(args: {
  content: CoverLetterContent;
  plan: LetterPlan;
  snapshot: Parameters<typeof renderLetter>[0]["snapshot"];
  settings: GenerationSettings;
  sanitize?: (text: string) => string;
}): Promise<LetterFitOutcome> {
  const { content, plan, snapshot, settings } = args;
  const scoreOf = new Map(plan.items.map((i) => [i.key, i.score]));

  const render = (current: CoverLetterContent) =>
    renderLetter({
      content: current,
      snapshot,
      settings,
      ...(args.sanitize ? { sanitize: args.sanitize } : {}),
    });

  let current = content;
  let result = await render(current);
  let renders = 1;

  while (result.pageCount > settings.pageBudget) {
    // demote the lowest-scored remaining paragraph (ties → first, stable)
    const remaining = current.paragraphs.map((p) => ({ claimId: p.claimId, score: scoreOf.get(p.claimId) ?? 0 }));
    if (remaining.length <= 1) {
      throw budgetConflict(
        `The cover letter needs ${result.pageCount} pages but the budget is ${settings.pageBudget} and the ` +
          "remaining paragraph cannot be omitted (an empty letter is not a deliverable). Trim the letter content.",
      );
    }
    const lowest = remaining.reduce((acc, item) => (item.score < acc.score ? item : acc));
    current = {
      ...current,
      paragraphs: current.paragraphs.filter((p) => p.claimId !== lowest.claimId),
      omissions: [...current.omissions, { type: "letter_paragraph", id: lowest.claimId, reason: PAGE_BUDGET_REASON }],
    };
    result = await render(current);
    renders += 1;
  }

  return { content: current, bytes: result.bytes, pageCount: result.pageCount, renders };
}
