import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { z } from "zod";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { GeneratedCVContent, GenerationSettings, OutputLanguage } from "@/lib/generation/schemas";
import { activeSections, renderMetaOf, type RenderedPdf } from "@/lib/generation/render/cv";
import { formatDate, formatDateRange, sanitizeWinAnsi, sectionHeading, wrapText } from "@/lib/generation/render/template";

/**
 * The designed two-column CV template (phase 8, assets/ProfileForge-CV-Template.docx):
 * a shaded left sidebar (name, initials placeholder, contact, skills, languages)
 * and a main column (summary, experience, education, optional projects and
 * certifications). Every multi-value list renders DYNAMICALLY — one block per
 * content/snapshot item, no fixed slot counts. Still standard-font text only,
 * WinAnsi-sanitized, so the same extraction gate verifies it like the ATS PDF.
 */

// --- Design tokens (shared with the DOCX renderer) ---

export const DESIGNED_TOKENS = Object.freeze({
  navy: "1E3A5F", // headings + name
  sidebarFill: "E8F0F8", // sidebar band
  body: "000000",
  muted: "666666", // initials placeholder
  meta: "888888", // dates / institution lines
  font: "Calibri", // DOCX font face (PDF uses the Helvetica stand-in)
});

// --- Fixed geometry (A4, 36pt margins, sidebar 183pt per the template grid) ---

const PAGE = { width: 595, height: 842, margin: 36 } as const;
const SIDEBAR = { x: 36, width: 183, pad: 12 } as const;
const MAIN = { x: 233, width: 318 } as const; // 233..551 leaves a right pad

const COLOR = {
  navy: rgb(0x1e / 255, 0x3a / 255, 0x5f / 255),
  sidebar: rgb(0xe8 / 255, 0xf0 / 255, 0xf8 / 255),
  body: rgb(0, 0, 0),
  muted: rgb(0x66 / 255, 0x66 / 255, 0x66 / 255),
  meta: rgb(0x88 / 255, 0x88 / 255, 0x88 / 255),
};

// --- Sidebar labels (localized; section headings reuse SECTION_HEADINGS) ---

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

// --- Basics view (sidebar needs location in addition to the gate's contact set) ---

const BasicsViewSchema = z
  .object({
    name: z.string().nullish(),
    location: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    links: z.array(z.string()).nullish(),
  })
  .nullish();

type SidebarBasics = { name: string | null; location: string | null; email: string | null; phone: string | null; links: string[] };

function sidebarBasics(snapshot: PinnedSnapshot): SidebarBasics {
  const basics = BasicsViewSchema.parse(snapshot.basics ?? null) ?? {};
  const clean = (v: string | null | undefined): string | null => v?.trim() || null;
  return {
    name: clean(basics.name),
    location: clean(basics.location),
    email: clean(basics.email),
    phone: clean(basics.phone),
    links: (basics.links ?? []).map((l) => l.trim()).filter(Boolean),
  };
}

/** "Camille Durand" → "CD" — the photo placeholder's initials (no photo in the data model). */
function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

// --- The two-column document builder ---

type Style = {
  font: "regular" | "bold";
  size: number;
  lineHeight: number;
  spaceBefore: number;
  spaceAfter: number;
  color: typeof COLOR.body;
};

const SIDEBAR_STYLES = {
  name: { font: "bold", size: 16, lineHeight: 20, spaceBefore: 0, spaceAfter: 6, color: COLOR.navy },
  heading: { font: "bold", size: 12.5, lineHeight: 16, spaceBefore: 10, spaceAfter: 4, color: COLOR.navy },
  body: { font: "regular", size: 9.5, lineHeight: 12.5, spaceBefore: 0, spaceAfter: 1.5, color: COLOR.body },
} as const satisfies Record<string, Style>;

const MAIN_STYLES = {
  heading: { font: "bold", size: 13, lineHeight: 17, spaceBefore: 12, spaceAfter: 4, color: COLOR.navy },
  entry: { font: "bold", size: 10.5, lineHeight: 14, spaceBefore: 6, spaceAfter: 0.5, color: COLOR.body },
  meta: { font: "regular", size: 9, lineHeight: 12, spaceBefore: 0, spaceAfter: 2.5, color: COLOR.meta },
  body: { font: "regular", size: 10, lineHeight: 13.5, spaceBefore: 0, spaceAfter: 3.5, color: COLOR.body },
  bullet: { font: "regular", size: 10, lineHeight: 13.5, spaceBefore: 0, spaceAfter: 2, color: COLOR.body },
} as const satisfies Record<string, Style>;

/**
 * Two independent text flows (sidebar / main) over shared band-backed pages:
 * whichever flow needs a page beyond the current set extends it, and the other
 * flow reuses the page already created. `pageCount` stays exact for the fit loop.
 */
class TwoColumnDoc {
  private readonly doc: PDFDocument;
  private readonly fonts: { regular: PDFFont; bold: PDFFont };
  private readonly sanitize: (text: string) => string;
  private readonly pages: PDFPage[] = [];
  private readonly sidebar = { page: 0, y: 0 };
  private readonly main = { page: 0, y: 0 };

  private constructor(doc: PDFDocument, fonts: { regular: PDFFont; bold: PDFFont }, sanitize: (text: string) => string) {
    this.doc = doc;
    this.fonts = fonts;
    this.sanitize = sanitize;
    const first = this.newPage();
    this.pages.push(first);
    this.sidebar.y = PAGE.height - PAGE.margin;
    this.main.y = PAGE.height - PAGE.margin;
  }

  static async create(sanitize: (text: string) => string = sanitizeWinAnsi): Promise<TwoColumnDoc> {
    const doc = await PDFDocument.create();
    const fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
    return new TwoColumnDoc(doc, fonts, sanitize);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  async toBytes(): Promise<Uint8Array> {
    return this.doc.save();
  }

  /** A fresh page with the full-height sidebar band already painted on it. */
  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE.width, PAGE.height]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: SIDEBAR.x - 6 + SIDEBAR.width + 12, // the band spans margin-to-margin of the sidebar column
      height: PAGE.height,
      color: COLOR.sidebar,
    });
    return page;
  }

  private ensurePage(index: number): PDFPage {
    while (this.pages.length <= index) this.pages.push(this.newPage());
    return this.pages[index]!;
  }

  /** Draw one wrapped text block into a flow; paginates inside the column. */
  private drawBlock(
    flow: "sidebar" | "main",
    text: string,
    style: Style,
    opts: { x: number; width: number; top: number; bottom: number; hangingIndent?: number },
  ): void {
    const clean = this.sanitize(text);
    if (!clean.trim()) return;
    const cursor = flow === "sidebar" ? this.sidebar : this.main;
    const font = style.font === "bold" ? this.fonts.bold : this.fonts.regular;
    const wrapped = wrapText(clean, font, style.size, opts.width - (opts.hangingIndent ?? 0));

    const advance = (height: number): void => {
      cursor.y -= height;
      if (cursor.y < opts.bottom) {
        cursor.page += 1;
        this.ensurePage(cursor.page);
        cursor.y = opts.top;
      }
    };

    advance(style.spaceBefore);
    for (const [index, line] of wrapped.entries()) {
      advance(style.lineHeight);
      const page = this.ensurePage(cursor.page);
      page.drawText(line, {
        x: opts.x + (index === 0 ? 0 : (opts.hangingIndent ?? 0)),
        y: cursor.y,
        size: style.size,
        font,
        color: style.color,
      });
    }
    advance(style.spaceAfter);
  }

  // -- sidebar primitives --

  sidebarName(text: string): void {
    this.drawBlock("sidebar", text, SIDEBAR_STYLES.name, this.sidebarBox());
  }

  /** The photo placeholder: initials in a bordered square (the profile model has no photo). */
  sidebarInitials(name: string): void {
    const box = this.sidebarBox();
    const cursor = this.sidebar;
    if (cursor.y - 40 < box.bottom) {
      cursor.page += 1;
      this.ensurePage(cursor.page);
      cursor.y = box.top;
    }
    cursor.y -= 6;
    const size = 30;
    const page = this.ensurePage(cursor.page);
    page.drawRectangle({
      x: box.x,
      y: cursor.y - size,
      width: size,
      height: size,
      borderColor: COLOR.muted,
      borderWidth: 1,
    });
    page.drawText(this.sanitize(initialsOf(name)), {
      x: box.x + 9,
      y: cursor.y - size + 10,
      size: 11,
      font: this.fonts.regular,
      color: COLOR.muted,
    });
    cursor.y -= size + 8;
  }

  sidebarHeading(text: string): void {
    this.drawBlock("sidebar", text, SIDEBAR_STYLES.heading, this.sidebarBox());
  }

  sidebarBody(text: string): void {
    this.drawBlock("sidebar", text, SIDEBAR_STYLES.body, this.sidebarBox());
  }

  private sidebarBox(): { x: number; width: number; top: number; bottom: number } {
    return {
      x: SIDEBAR.x + SIDEBAR.pad,
      width: SIDEBAR.width - 2 * SIDEBAR.pad,
      top: PAGE.height - PAGE.margin,
      bottom: PAGE.margin,
    };
  }

  // -- main primitives --

  mainHeading(text: string): void {
    this.drawBlock("main", text, MAIN_STYLES.heading, this.mainBox());
  }

  mainEntryTitle(text: string): void {
    this.drawBlock("main", text, MAIN_STYLES.entry, this.mainBox());
  }

  mainMeta(text: string): void {
    this.drawBlock("main", text, MAIN_STYLES.meta, this.mainBox());
  }

  mainBody(text: string): void {
    this.drawBlock("main", text, MAIN_STYLES.body, this.mainBox());
  }

  mainBullet(text: string): void {
    const clean = this.sanitize(text);
    if (!clean.trim()) return;
    const marked = `- ${clean}`; // one block per bullet — the count is dynamic
    this.drawBlock("main", marked, MAIN_STYLES.bullet, { ...this.mainBox(), hangingIndent: 8 });
  }

  private mainBox(): { x: number; width: number; top: number; bottom: number } {
    return { x: MAIN.x, width: MAIN.width, top: PAGE.height - PAGE.margin, bottom: PAGE.margin };
  }
}

/** Render the fitted CV content in the designed two-column layout. Deterministic:
 *  fixed draw order, no timestamps — the same inputs produce the same bytes. */
export async function renderDesignedCV(args: {
  content: GeneratedCVContent;
  snapshot: PinnedSnapshot;
  settings: GenerationSettings;
  sanitize?: (text: string) => string;
}): Promise<RenderedPdf> {
  const language: OutputLanguage = args.settings.outputLanguage;
  const doc = await TwoColumnDoc.create(args.sanitize ?? sanitizeWinAnsi);
  const { content } = args;
  const basics = sidebarBasics(args.snapshot);

  // --- Sidebar: name, photo placeholder, contact, skills, languages ---
  if (basics.name) doc.sidebarName(basics.name);
  if (basics.name) doc.sidebarInitials(basics.name);

  const labels = CONTACT_LABELS[language];
  const contactLines = [
    basics.location ? `${labels.address}: ${basics.location}` : null,
    basics.phone ? `${labels.phone}: ${basics.phone}` : null,
    basics.email ? `${labels.email}: ${basics.email}` : null,
    ...basics.links,
  ].filter((line): line is string => line !== null);
  if (contactLines.length > 0) {
    doc.sidebarHeading(CONTACT_HEADING[language]);
    for (const line of contactLines) doc.sidebarBody(line);
  }

  if (content.skills.length > 0) {
    doc.sidebarHeading(sectionHeading(language, "skills"));
    for (const skill of content.skills) doc.sidebarBody(`• ${skill}`); // one line per skill — dynamic
  }

  if (args.snapshot.languages.length > 0) {
    doc.sidebarHeading(sectionHeading(language, "languages"));
    for (const language_ of args.snapshot.languages) {
      doc.sidebarBody(language_.proficiency ? `${language_.name} — ${language_.proficiency}` : language_.name);
    }
  }

  // --- Main column: summary → experience → education → projects → certifications ---
  const sections = new Set(activeSections(content));

  if (sections.has("summary")) {
    doc.mainHeading(sectionHeading(language, "summary"));
    doc.mainBody(content.summary);
  }

  if (sections.has("experience")) {
    doc.mainHeading(sectionHeading(language, "experience"));
    for (const entry of content.experience) {
      if (entry.bullets.length === 0) continue;
      const meta = renderMetaOf.experience(args.snapshot, entry.id);
      if (meta) {
        // feature 005 US2: the rewritten title (fallback: the snapshot title)
        const title = entry.title?.text?.trim() || meta.title;
        const dates = formatDateRange(meta.startDate, meta.endDate);
        doc.mainEntryTitle(dates ? `${title}   ${dates}` : title);
        const place = [meta.company, meta.location].filter(Boolean).join(", ");
        if (place) doc.mainMeta(place);
      }
      for (const bullet of entry.bullets) doc.mainBullet(bullet.text); // dynamic bullet count
    }
  }

  if (sections.has("education")) {
    doc.mainHeading(sectionHeading(language, "education"));
    for (const education of content.education) {
      const meta = renderMetaOf.education(args.snapshot, education.id);
      const dates = meta ? formatDateRange(meta.startDate, meta.endDate) : "";
      doc.mainEntryTitle(dates ? `${education.text}   ${dates}` : education.text);
      if (meta?.institution) doc.mainMeta(meta.institution);
    }
  }

  if (sections.has("projects")) {
    doc.mainHeading(sectionHeading(language, "projects"));
    for (const project of content.projects) {
      if (project.bullets.length === 0) continue;
      const meta = renderMetaOf.project(args.snapshot, project.id);
      if (meta) {
        const dates = formatDateRange(meta.startDate, meta.endDate);
        doc.mainEntryTitle(dates ? `${meta.name}   ${dates}` : meta.name);
      }
      for (const bullet of project.bullets) doc.mainBullet(bullet.text);
    }
  }

  if (sections.has("certifications")) {
    doc.mainHeading(sectionHeading(language, "certifications"));
    for (const certification of content.certifications) {
      const meta = renderMetaOf.certification(args.snapshot, certification.id);
      const issued = meta?.issueDate ? formatDate(meta.issueDate) : "";
      doc.mainBody(issued ? `${certification.text} (${issued})` : certification.text);
    }
  }

  return { bytes: await doc.toBytes(), pageCount: doc.pageCount };
}
