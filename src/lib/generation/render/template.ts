import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { OutputLanguage } from "@/lib/generation/schemas";

/**
 * Shared single-column ATS template primitives (contracts/generation-pipeline.md
 * §Rendered template invariants, research R1): one fixed column, standard-font
 * (WinAnsi) text only, no headers/footers/images, bilingual heading map,
 * normalized `YYYY-MM`/`present` dates, and a sanitizer that keeps Latin-1
 * diacritics while folding everything the standard fonts cannot encode.
 */

// --- Fixed geometry (single column, nothing outside the body) ---

export const PAGE_LAYOUT = {
  pageWidth: 595,
  pageHeight: 842,
  margin: 48,
  columnWidth: 595 - 2 * 48,
} as const;

// --- Bilingual heading map (exact, FR/EN) ---

export type SectionKey =
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "languages";

export const SECTION_HEADINGS: Record<OutputLanguage, Record<SectionKey, string>> = Object.freeze({
  en: Object.freeze({
    summary: "Professional Summary",
    experience: "Experience",
    education: "Education",
    skills: "Skills",
    projects: "Projects",
    certifications: "Certifications",
    languages: "Languages",
  }),
  fr: Object.freeze({
    summary: "Résumé professionnel",
    experience: "Expérience professionnelle",
    education: "Formation",
    skills: "Compétences",
    projects: "Projets",
    certifications: "Certifications",
    languages: "Langues",
  }),
  de: Object.freeze({
    summary: "Kurzprofil",
    experience: "Berufserfahrung",
    education: "Ausbildung",
    skills: "Fähigkeiten",
    projects: "Projekte",
    certifications: "Zertifikate",
    languages: "Sprachen",
  }),
});

export function sectionHeading(language: OutputLanguage, key: SectionKey): string {
  return SECTION_HEADINGS[language][key];
}

// --- Dates: normalized `YYYY-MM` / "present" ---

/** A single date value as the renderer draws it: `present` or the `YYYY-MM`
 *  passthrough; missing values draw nothing. */
export function formatDate(date: string | null | undefined): string {
  const value = date?.trim();
  if (!value) return "";
  return value; // snapshot dates are validated upstream as YYYY-MM | "present"
}

/** `start - end` with a null end rendered as `present` (ongoing); an open
 *  range without a start draws only the end. */
export function formatDateRange(start: string | null | undefined, end: string | null | undefined): string {
  const startText = formatDate(start);
  const endText = formatDate(end) || (startText ? "present" : "");
  return [startText, endText].filter(Boolean).join(" - ");
}

// --- WinAnsi-safe text ---

/** Typographic characters substituted before draw: the standard fonts' WinAnsi
 *  space is kept deliberately narrow here so extraction sees plain ASCII. */
const WINANSI_SUBSTITUTIONS: Record<string, string> = {
  "\u2018": "'", // ‘
  "\u2019": "'", // ’
  "\u201A": ",", // ‚
  "\u201C": '"', // “
  "\u201D": '"', // ”
  "\u2032": "'",
  "\u2033": '"',
  "\u2013": "-", // –
  "\u2014": "-", // —
  "\u2212": "-", // minus sign
  "\u00AD": "", // soft hyphen
  "\u2010": "-",
  "\u2011": "-",
  "\u2026": "...",
  "\u2022": "-", // bullet
  "\u00A0": " ", // no-break space
  "\u202F": " ", // narrow no-break space
  "\u2009": " ", // thin space
  "\u200B": "", // zero-width space
  "\u20AC": "EUR",
  "\u2122": "(TM)",
  "\u00A9": "(c)",
  "\u00AE": "(r)",
  "\u2030": "0/00",
  "\u2039": "<",
  "\u203A": ">",
};

/** Map substitutions, then fold any remaining non-WinAnsi codepoint: NFD-
 *  decompose, keep the Latin (≤ 0xFF) base, drop the rest. Latin-1 diacritics
 *  (é è ç à …) are single codepoints ≤ 0xFF and pass through untouched. */
function fold(text: string): string {
  let out = "";
  for (const char of text) {
    const mapped = WINANSI_SUBSTITUTIONS[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0)!;
    if (code <= 0xff) {
      out += char; // WinAnsi covers Latin-1 (plus € etc. handled above)
      continue;
    }
    out += char.normalize("NFD").replace(/\p{M}+/gu, ""); // keep the Latin base
  }
  return out;
}

/** Characters with no Latin base after folding leave nothing drawable. */
function stripNonLatin(text: string): string {
  let out = "";
  for (const char of text) {
    out += char.codePointAt(0)! <= 0xff ? char : "";
  }
  return out;
}

/** Default draw-time sanitizer: WinAnsi-safe, diacritics preserved (locked by
 *  tests/unit/generation-template.test.ts). */
export function sanitizeWinAnsi(text: string): string {
  return stripNonLatin(fold(text));
}

/** Aggressive fallback pass used by gate retries: everything to plain ASCII.
 *  The gate's normalization is accent-insensitive, so a de-accented render
 *  still passes — this only rescues encodability, never meaning. */
export function sanitizeToAscii(text: string): string {
  return stripNonLatin(fold(text).normalize("NFD").replace(/\p{M}+/gu, ""));
}

// --- Text measurement ---

/** Greedy word wrap for a fixed column width (measures with the real font). */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// --- The single-column document builder ---

type TextStyle = {
  font: "regular" | "bold";
  size: number;
  lineHeight: number;
  spaceBefore: number;
  spaceAfter: number;
};

const STYLES = {
  name: { font: "bold", size: 16, lineHeight: 20, spaceBefore: 0, spaceAfter: 2 },
  contact: { font: "regular", size: 9, lineHeight: 12, spaceBefore: 0, spaceAfter: 4 },
  section: { font: "bold", size: 11.5, lineHeight: 15, spaceBefore: 12, spaceAfter: 4 },
  entry: { font: "bold", size: 10.5, lineHeight: 14, spaceBefore: 6, spaceAfter: 1 },
  meta: { font: "regular", size: 9, lineHeight: 12, spaceBefore: 0, spaceAfter: 3 },
  body: { font: "regular", size: 10, lineHeight: 13.5, spaceBefore: 0, spaceAfter: 4 },
  bullet: { font: "regular", size: 10, lineHeight: 13.5, spaceBefore: 0, spaceAfter: 2 },
} as const satisfies Record<string, TextStyle>;

const BULLET_MARKER = "- ";
const BULLET_HANG = 10;

/**
 * A one-column PDF that paginates itself: every draw is body text inside
 * `PAGE_LAYOUT.margin` on every page — no headers, footers, or images exist,
 * so nothing can appear outside the body content. `pageCount` is exact
 * (pdf-lib measures as it draws), which is what the fit loop relies on.
 */
export class SingleColumnDoc {
  private readonly doc: PDFDocument;
  private readonly fonts: { regular: PDFFont; bold: PDFFont };
  private readonly sanitize: (text: string) => string;
  private page: PDFPage;
  private y: number;

  private constructor(
    doc: PDFDocument,
    page: PDFPage,
    fonts: { regular: PDFFont; bold: PDFFont },
    sanitize: (text: string) => string,
  ) {
    this.doc = doc;
    this.page = page;
    this.fonts = fonts;
    this.sanitize = sanitize;
    this.y = PAGE_LAYOUT.pageHeight - PAGE_LAYOUT.margin;
  }

  static async create(sanitize: (text: string) => string = sanitizeWinAnsi): Promise<SingleColumnDoc> {
    const doc = await PDFDocument.create();
    const fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
    const page = doc.addPage([PAGE_LAYOUT.pageWidth, PAGE_LAYOUT.pageHeight]);
    return new SingleColumnDoc(doc, page, fonts, sanitize);
  }

  get pageCount(): number {
    return this.doc.getPageCount();
  }

  async toBytes(): Promise<Uint8Array> {
    return this.doc.save();
  }

  // -- public draw primitives (all sanitize before measuring/drawing) --

  addNameLine(text: string): void {
    this.drawBlock(text, STYLES.name, 0, 0);
  }

  addContactLine(text: string): void {
    this.drawBlock(text, STYLES.contact, 0, 0);
  }

  addSectionHeading(text: string): void {
    this.drawBlock(text, STYLES.section, 0, 0);
  }

  addEntryHeading(text: string): void {
    this.drawBlock(text, STYLES.entry, 0, 0);
  }

  addEntryMetaLine(text: string): void {
    this.drawBlock(text, STYLES.meta, 0, 0);
  }

  addBodyParagraph(text: string): void {
    this.drawBlock(text, STYLES.body, 0, 0);
  }

  /** One bullet: "- " marker with a hanging indent for wrapped lines. */
  addBulletLine(text: string): void {
    const clean = this.sanitize(text);
    if (!clean.trim()) return;
    const { size, lineHeight, spaceBefore, spaceAfter } = STYLES.bullet;
    const wrapped = wrapText(clean, this.fonts.regular, size, PAGE_LAYOUT.columnWidth - BULLET_HANG);
    const lines = wrapped.length ? [BULLET_MARKER + wrapped[0], ...wrapped.slice(1)] : [];
    this.drawLines(lines, this.fonts.regular, size, lineHeight, spaceBefore, spaceAfter, BULLET_HANG);
  }

  // -- internals --

  private drawBlock(text: string, style: TextStyle, indentFirst: number, indentRest: number): void {
    const clean = this.sanitize(text);
    if (!clean.trim()) return;
    const font = style.font === "bold" ? this.fonts.bold : this.fonts.regular;
    const lines = wrapText(clean, font, style.size, PAGE_LAYOUT.columnWidth - indentFirst);
    this.drawLines(lines, font, style.size, style.lineHeight, style.spaceBefore, style.spaceAfter, indentRest || indentFirst);
  }

  private drawLines(
    lines: string[],
    font: PDFFont,
    size: number,
    lineHeight: number,
    spaceBefore: number,
    spaceAfter: number,
    indent: number,
  ): void {
    this.advance(spaceBefore);
    for (const [index, line] of lines.entries()) {
      this.advance(lineHeight);
      const x = PAGE_LAYOUT.margin + (index === 0 ? 0 : indent);
      this.page.drawText(line, { x, y: this.y, size, font });
    }
    this.advance(spaceAfter);
  }

  /** Move the pen down, starting a fresh page when the body area is exhausted. */
  private advance(height: number): void {
    this.y -= height;
    if (this.y < PAGE_LAYOUT.margin) {
      this.page = this.doc.addPage([PAGE_LAYOUT.pageWidth, PAGE_LAYOUT.pageHeight]);
      this.y = PAGE_LAYOUT.pageHeight - PAGE_LAYOUT.margin;
    }
  }
}
