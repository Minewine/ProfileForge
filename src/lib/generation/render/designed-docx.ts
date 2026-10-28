import { Document, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { z } from "zod";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings, OutputLanguage } from "@/lib/generation/schemas";
import { activeSections, renderMetaOf } from "@/lib/generation/render/cv";
import { DESIGNED_TOKENS } from "@/lib/generation/render/designed";
import { formatDate, formatDateRange, sectionHeading } from "@/lib/generation/render/template";

/**
 * The designed two-column DOCX (phase 8): mirrors the attached
 * ProfileForge-CV-Template.docx — a 3663/6803-twip two-column table, Calibri,
 * navy 1E3A5F headings, sidebar shaded E8F0F8 — with every multi-value list
 * rendered as one paragraph per item (dynamic counts, never fixed slots).
 */

const PAGE_TWIPS = { margin: 720, sidebar: 3663, main: 6803 } as const;

const CONTACT_HEADING: Record<OutputLanguage, string> = Object.freeze({
  en: "Contact",
  fr: "Contact",
  de: "Kontakt",
});
const CONTACT_LABELS: Record<OutputLanguage, { address: string; phone: string; email: string }> = Object.freeze({
  en: { address: "Address", phone: "Phone", email: "E-mail" },
  fr: { address: "Adresse", phone: "Téléphone", email: "E-mail" },
  de: { address: "Adresse", phone: "Telefon", email: "E-mail" },
});

const BasicsViewSchema = z
  .object({
    name: z.string().nullish(),
    location: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    links: z.array(z.string()).nullish(),
  })
  .nullish();

function run(text: string, o: { bold?: boolean; size?: number; color?: string } = {}): TextRun {
  return new TextRun({
    text,
    bold: o.bold ?? true, // the template sets bold on every run — keep the look
    size: o.size ?? 20, // half-points ⇒ 10pt body
    color: o.color ?? DESIGNED_TOKENS.body,
  });
}

function para(text: string, o: { bold?: boolean; size?: number; color?: string } = {}): Paragraph {
  return new Paragraph({ children: [run(text, o)] });
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** The sidebar cell: name, initials placeholder, contact, skills, languages. */
function sidebarChildren(args: {
  snapshot: PinnedSnapshot;
  content: GeneratedCVContent;
  language: OutputLanguage;
}): Paragraph[] {
  const basics = BasicsViewSchema.parse(args.snapshot.basics ?? null) ?? {};
  const clean = (v: string | null | undefined): string | null => v?.trim() || null;
  const children: Paragraph[] = [];

  const name = clean(basics.name);
  if (name) {
    children.push(para(name, { size: 36, color: DESIGNED_TOKENS.navy })); // 18pt
    children.push(para(`[${initialsOf(name)}]`, { size: 18, color: DESIGNED_TOKENS.muted })); // photo placeholder
  }

  const labels = CONTACT_LABELS[args.language];
  const contactLines = [
    clean(basics.location) ? `${labels.address}: ${clean(basics.location)}` : null,
    clean(basics.phone) ? `${labels.phone}: ${clean(basics.phone)}` : null,
    clean(basics.email) ? `${labels.email}: ${clean(basics.email)}` : null,
    ...(basics.links ?? []).map((l) => l.trim()).filter(Boolean),
  ].filter((line): line is string => line !== null);
  if (contactLines.length > 0) {
    children.push(para(CONTACT_HEADING[args.language], { size: 28, color: DESIGNED_TOKENS.navy })); // 14pt
    children.push(...contactLines.map((line) => para(line)));
  }

  if (args.content.skills.length > 0) {
    children.push(para(sectionHeading(args.language, "skills"), { size: 28, color: DESIGNED_TOKENS.navy }));
    children.push(...args.content.skills.map((skill) => para(`• ${skill}`))); // one paragraph per skill
  }

  if (args.snapshot.languages.length > 0) {
    children.push(para(sectionHeading(args.language, "languages"), { size: 28, color: DESIGNED_TOKENS.navy }));
    children.push(
      ...args.snapshot.languages.map((l) =>
        para(l.proficiency ? `${l.name} — ${l.proficiency}` : l.name), // one paragraph per language
      ),
    );
  }
  return children;
}

/** The main cell: summary → experience → education → projects → certifications. */
function mainChildren(args: {
  content: GeneratedCVContent;
  snapshot: PinnedSnapshot;
  language: OutputLanguage;
}): Paragraph[] {
  const { content, snapshot, language } = args;
  const children: Paragraph[] = [];
  const sections = new Set(activeSections(content));
  const heading14 = (text: string): Paragraph => para(text, { size: 28, color: DESIGNED_TOKENS.navy });

  if (sections.has("summary")) {
    children.push(heading14(sectionHeading(language, "summary")));
    children.push(para(content.summary, { bold: false }));
  }

  if (sections.has("experience")) {
    children.push(heading14(sectionHeading(language, "experience")));
    for (const entry of content.experience) {
      if (entry.bullets.length === 0) continue;
      const meta = renderMetaOf.experience(snapshot, entry.id);
      if (meta) {
        // feature 005 US2: the rewritten title (fallback: the snapshot title)
        const title = entry.title?.text?.trim() || meta.title;
        const dates = formatDateRange(meta.startDate, meta.endDate);
        children.push(para(dates ? `${title}   ${dates}` : title, { size: 22 })); // 11pt
        const place = [meta.company, meta.location].filter(Boolean).join(", ");
        if (place) children.push(para(place));
      }
      children.push(...entry.bullets.map((b) => para(b.text, { bold: false }))); // dynamic count
    }
  }

  if (sections.has("education")) {
    children.push(heading14(sectionHeading(language, "education")));
    for (const education of content.education) {
      const meta = renderMetaOf.education(snapshot, education.id);
      const dates = meta ? formatDateRange(meta.startDate, meta.endDate) : "";
      children.push(para(dates ? `${education.text}   ${dates}` : education.text, { size: 22 }));
      if (meta?.institution) children.push(para(meta.institution, { size: 18, color: DESIGNED_TOKENS.meta }));
    }
  }

  if (sections.has("projects")) {
    children.push(heading14(sectionHeading(language, "projects")));
    for (const project of content.projects) {
      if (project.bullets.length === 0) continue;
      const meta = renderMetaOf.project(snapshot, project.id);
      if (meta) {
        const dates = formatDateRange(meta.startDate, meta.endDate);
        children.push(para(dates ? `${meta.name}   ${dates}` : meta.name, { size: 22 }));
      }
      children.push(...project.bullets.map((b) => para(b.text, { bold: false })));
    }
  }

  if (sections.has("certifications")) {
    children.push(heading14(sectionHeading(language, "certifications")));
    for (const certification of content.certifications) {
      const meta = renderMetaOf.certification(snapshot, certification.id);
      const issued = meta?.issueDate ? formatDate(meta.issueDate) : "";
      children.push(para(issued ? `${certification.text} (${issued})` : certification.text, { bold: false }));
    }
  }
  return children;
}

export async function renderDesignedDocx(args: {
  content: GeneratedCVContent;
  snapshot: PinnedSnapshot;
  settings: GenerationSettings;
}): Promise<Uint8Array> {
  const language = args.settings.outputLanguage;
  const sidebar = new TableCell({
    children: sidebarChildren({ snapshot: args.snapshot, content: args.content, language }),
    shading: { type: ShadingType.CLEAR, fill: DESIGNED_TOKENS.sidebarFill, color: "auto" },
    width: { size: PAGE_TWIPS.sidebar, type: WidthType.DXA },
  });
  const mainCell = new TableCell({
    children: mainChildren({ content: args.content, snapshot: args.snapshot, language }),
    width: { size: PAGE_TWIPS.main, type: WidthType.DXA },
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: DESIGNED_TOKENS.font } } } },
    sections: [
      {
        children: [
          new Table({
            columnWidths: [PAGE_TWIPS.sidebar, PAGE_TWIPS.main],
            width: { size: PAGE_TWIPS.sidebar + PAGE_TWIPS.main, type: WidthType.DXA },
            rows: [new TableRow({ children: [sidebar, mainCell] })],
          }),
        ],
        properties: { page: { margin: { top: PAGE_TWIPS.margin, right: PAGE_TWIPS.margin, bottom: PAGE_TWIPS.margin, left: PAGE_TWIPS.margin } } },
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
