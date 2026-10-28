import { z } from "zod";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings } from "@/lib/generation/schemas";
import type { OutputLanguage } from "@/lib/generation/schemas";
import {
  SingleColumnDoc,
  formatDate,
  formatDateRange,
  sanitizeWinAnsi,
  sectionHeading,
  type SectionKey,
} from "@/lib/generation/render/template";

/**
 * The CV renderer (stage 5, FR-011/FR-012): single-column body text only —
 * name/contact atop page 1, then Summary → Experience → Education → Skills →
 * optional Projects/Certifications/Languages when content exists (no empty
 * headings), dates as `YYYY-MM`/`present`, no headers/footers/images.
 */

export type RenderedPdf = { bytes: Uint8Array; pageCount: number };

// --- Basics view (name + contact items come from the pinned snapshot) ---

const BasicsViewSchema = z
  .object({
    name: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    links: z.array(z.string()).nullish(),
  })
  .nullish();

export type CVBasics = { name: string | null; contact: Array<{ label: string; value: string }> };

/** Non-empty name and contact items (email/phone/links) from the snapshot's
 *  `basics` — the level-1 structural elements of the extraction gate. */
export function cvBasics(snapshot: PinnedSnapshot): CVBasics {
  const basics = BasicsViewSchema.parse(snapshot.basics ?? null);
  if (!basics) return { name: null, contact: [] };
  const labeled = [
    { label: "email", value: basics.email },
    { label: "phone", value: basics.phone },
    ...(basics.links ?? []).map((value, index) => ({ label: `link:${index}`, value })),
  ];
  return {
    name: basics.name?.trim() || null,
    contact: labeled
      .map((item) => ({ ...item, value: item.value?.trim() ?? "" }))
      .filter((item) => item.value !== ""),
  };
}

// --- Rendered-section predicate (shared by renderer and gate) ---

/** Sections that carry content (single source of truth for "no empty headings"
 *  and for the gate's rendered-heading checks). Fixed order. */
export function activeSections(content: GeneratedCVContent): SectionKey[] {
  const sections: SectionKey[] = [];
  if (content.summary.trim()) sections.push("summary");
  if (content.experience.some((e) => e.bullets.length > 0)) sections.push("experience");
  if (content.education.length > 0) sections.push("education");
  if (content.skills.length > 0) sections.push("skills");
  if (content.projects.some((p) => p.bullets.length > 0)) sections.push("projects");
  if (content.certifications.length > 0) sections.push("certifications");
  return sections; // "languages" never carries CV content in this slice
}

// --- Entry meta (company/title/dates resolved against the pinned snapshot) ---

/** Snapshot lookups shared by the PDF/DOCX renderers and the extraction gate. */
export const renderMetaOf = {
  experience(snapshot: PinnedSnapshot, entryId: string) {
    return snapshot.experience.find((e) => e.id === entryId) ?? null;
  },
  project(snapshot: PinnedSnapshot, projectId: string) {
    return snapshot.projects.find((p) => p.id === projectId) ?? null;
  },
  education(snapshot: PinnedSnapshot, educationId: string) {
    return snapshot.education.find((e) => e.id === educationId) ?? null;
  },
  certification(snapshot: PinnedSnapshot, certificationId: string) {
    return snapshot.certifications.find((c) => c.id === certificationId) ?? null;
  },
} as const;

/** Render the fitted CV content to a single-column PDF. Deterministic: the
 *  same inputs always produce the same bytes (`sanitize` defaults to the
 *  WinAnsi pass; the gate's retry loop passes the ASCII fallback). */
export async function renderCV(args: {
  content: GeneratedCVContent;
  snapshot: PinnedSnapshot;
  settings: GenerationSettings;
  sanitize?: (text: string) => string;
}): Promise<RenderedPdf> {
  const language: OutputLanguage = args.settings.outputLanguage;
  const doc = await SingleColumnDoc.create(args.sanitize ?? sanitizeWinAnsi);
  const { content } = args;

  const basics = cvBasics(args.snapshot);
  if (basics.name) doc.addNameLine(basics.name);
  if (basics.contact.length > 0) doc.addContactLine(basics.contact.map((item) => item.value).join(" · "));

  const sections = new Set(activeSections(content));
  if (sections.has("summary")) {
    doc.addSectionHeading(sectionHeading(language, "summary"));
    doc.addBodyParagraph(content.summary);
  }

  if (sections.has("experience")) {
    doc.addSectionHeading(sectionHeading(language, "experience"));
    for (const entry of content.experience) {
      if (entry.bullets.length === 0) continue;
      const meta = renderMetaOf.experience(args.snapshot, entry.id);
      if (meta) {
        // feature 005 US2: the rewritten title (fallback: the snapshot title)
        const title = entry.title?.text?.trim() || meta.title;
        doc.addEntryHeading([title, meta.company].filter(Boolean).join(" — "));
        const dates = formatDateRange(meta.startDate, meta.endDate);
        if (dates) doc.addEntryMetaLine(dates);
      }
      for (const bullet of entry.bullets) doc.addBulletLine(bullet.text);
    }
  }

  if (sections.has("education")) {
    doc.addSectionHeading(sectionHeading(language, "education"));
    for (const education of content.education) {
      const meta = renderMetaOf.education(args.snapshot, education.id);
      const dates = meta ? formatDateRange(meta.startDate, meta.endDate) : "";
      doc.addBodyParagraph(dates ? `${education.text} (${dates})` : education.text);
    }
  }

  if (sections.has("skills")) {
    doc.addSectionHeading(sectionHeading(language, "skills"));
    doc.addBodyParagraph(content.skills.join(", "));
  }

  if (sections.has("projects")) {
    doc.addSectionHeading(sectionHeading(language, "projects"));
    for (const project of content.projects) {
      if (project.bullets.length === 0) continue;
      const meta = renderMetaOf.project(args.snapshot, project.id);
      if (meta) {
        doc.addEntryHeading(meta.name);
        const dates = formatDateRange(meta.startDate, meta.endDate);
        if (dates) doc.addEntryMetaLine(dates);
      }
      for (const bullet of project.bullets) doc.addBulletLine(bullet.text);
    }
  }

  if (sections.has("certifications")) {
    doc.addSectionHeading(sectionHeading(language, "certifications"));
    for (const certification of content.certifications) {
      const meta = renderMetaOf.certification(args.snapshot, certification.id);
      const issued = meta?.issueDate ? formatDate(meta.issueDate) : "";
      doc.addBodyParagraph(issued ? `${certification.text} (${issued})` : certification.text);
    }
  }

  return { bytes: await doc.toBytes(), pageCount: doc.pageCount };
}
