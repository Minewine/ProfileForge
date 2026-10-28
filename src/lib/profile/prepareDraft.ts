import { normalizeDate } from "@/lib/dates/normalize";
import { checkContainment } from "@/lib/validation/sourceContainment";
import type { ProfileDraft } from "@/lib/validation/schemas";
import type { SectionPayloads } from "@/lib/profile/repository";

export type DraftFlag = { code: string; detail: string };

export type PreparedImport = {
  enrichedDraft: ProfileDraft & {
    experience: Array<ProfileDraft["experience"][number] & { startDate: string | null; endDate: string | null }>;
    education: Array<ProfileDraft["education"][number] & { startDate: string | null; endDate: string | null }>;
  };
  prepared: SectionPayloads;
  flags: DraftFlag[];
};

/**
 * Deterministic post-pass (contracts/parsecv-task.md): date normalization,
 * source-containment, low-confidence flagging, and preparation of the exact
 * payloads the repository imports. No LLM involved.
 */
export function prepareDraft(
  draft: ProfileDraft,
  sourceDocumentId: string,
  language: "fr" | "en",
  includedText: string,
): PreparedImport {
  const flags: DraftFlag[] = [];
  const src = (page: number | null | undefined) =>
    page != null ? { sourceLocator: { page } } : { sourceLocator: {} };

  const enrichedExperience = draft.experience.map((e, i) => {
    const start = normalizeDate(e.startDateRaw, language);
    const end = normalizeDate(e.endDateRaw, language);
    const reviewFlag = start.flag ?? (start.value == null && e.startDateRaw == null ? "missing_dates" : null);
    if (start.flag || end.flag) flags.push({ code: "ambiguous_date", detail: `experience[${i}] dates` });
    if (reviewFlag === "missing_dates") flags.push({ code: "missing_dates", detail: `experience[${i}] ${e.company}` });
    return { ...e, startDate: start.value, endDate: end.value, reviewFlag };
  });

  const enrichedEducation = draft.education.map((e, i) => {
    const start = normalizeDate(e.startDateRaw, language);
    const end = normalizeDate(e.endDateRaw, language);
    if (start.flag || end.flag) flags.push({ code: "ambiguous_date", detail: `education[${i}] dates` });
    return { ...e, startDate: start.value, endDate: end.value };
  });

  const prepared: SectionPayloads = {
    experience: enrichedExperience.map((e, i) => ({
      company: e.company,
      title: e.title,
      location: e.location ?? null,
      startDate: e.startDate,
      endDate: e.endDate,
      skillsUsed: e.skillsUsed,
      order: i,
      provenance: "imported",
      sourceDocumentId,
      ...src(e.page),
      language,
      reviewFlag: e.reviewFlag ?? null,
      bullets: e.bullets.map((b, j) => {
        const containment = checkContainment(b.text, includedText);
        if (!containment.ok) {
          flags.push({ code: "containment_failed", detail: `experience[${i}].bullets[${j}]: ${b.text.slice(0, 80)}` });
        }
        return {
          text: b.text,
          order: j,
          provenance: "imported",
          sourceDocumentId,
          ...src(b.page ?? e.page),
          language,
          containmentOk: containment.ok,
          reviewFlag: containment.ok ? null : "containment_failed",
        };
      }),
    })),
    education: enrichedEducation.map((e, i) => ({
      institution: e.institution,
      degree: e.degree ?? null,
      field: e.field ?? null,
      startDate: e.startDate,
      endDate: e.endDate,
      grade: null,
      order: i,
      provenance: "imported",
      sourceDocumentId,
      ...src(e.page),
      language,
      reviewFlag: e.startDate === null && e.endDate === null && (e.startDateRaw || e.endDateRaw)
        ? "ambiguous_date"
        : null,
    })),
    skills: draft.skills.map((s, i) => ({
      name: s.name,
      category: s.category ?? null,
      order: i,
      provenance: "imported",
      sourceDocumentId,
      ...src(s.page),
      language,
    })),
    languages: draft.languages.map((l, i) => ({
      name: l.name,
      proficiency: l.proficiency ?? null,
      order: i,
      provenance: "imported",
      sourceDocumentId,
      ...src(l.page),
      language,
    })),
    projects: draft.projects.map((p, i) => {
      const start = normalizeDate(p.startDateRaw, language);
      const end = normalizeDate(p.endDateRaw, language);
      return {
        name: p.name,
        description: p.description ?? null,
        link: p.link ?? null,
        startDate: start.value,
        endDate: end.value,
        order: i,
        provenance: "imported",
        sourceDocumentId,
        ...src(p.page),
        language,
        reviewFlag: start.flag || end.flag ? "ambiguous_date" : null,
      };
    }),
    certifications: draft.certifications.map((c, i) => {
      const issue = normalizeDate(c.issueDateRaw, language);
      if (issue.flag) flags.push({ code: "ambiguous_date", detail: `certifications[${i}] issueDate` });
      return {
        title: c.title,
        issuer: c.issuer ?? null,
        issueDate: issue.value,
        order: i,
        provenance: "imported",
        sourceDocumentId,
        ...src(c.page),
        language,
        reviewFlag: issue.flag,
      };
    }),
  };

  const enrichedDraft = {
    ...draft,
    experience: enrichedExperience,
    education: enrichedEducation,
  } as PreparedImport["enrichedDraft"];

  return { enrichedDraft, prepared, flags };
}
