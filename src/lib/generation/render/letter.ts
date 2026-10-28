import type { PinnedSnapshot } from "@/lib/generation/plan";
import type { CoverLetterContent, GenerationSettings } from "@/lib/generation/schemas";
import { cvBasics, type RenderedPdf } from "@/lib/generation/render/cv";
import { SingleColumnDoc, sanitizeWinAnsi } from "@/lib/generation/render/template";

/**
 * The cover-letter renderer (US6, FR-016/FR-017): single-column body text
 * only — name/contact atop the page (same basics line as the CV), then the
 * letter paragraphs in order. No section headings, no headers/footers/images;
 * the same template primitives, so the extraction gate applies unchanged.
 */

/** The copyable plain-text letter (for pasting into application forms). */
export function letterPlainText(content: CoverLetterContent): string {
  return content.paragraphs
    .map((p) => p.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/** Render the fitted letter content to a single-column PDF. Deterministic: the
 *  same inputs always produce the same bytes (`sanitize` defaults to the
 *  WinAnsi pass; the gate's retry loop passes the ASCII fallback). */
export async function renderLetter(args: {
  content: CoverLetterContent;
  snapshot: PinnedSnapshot;
  settings: GenerationSettings;
  sanitize?: (text: string) => string;
}): Promise<RenderedPdf> {
  const doc = await SingleColumnDoc.create(args.sanitize ?? sanitizeWinAnsi);

  const basics = cvBasics(args.snapshot);
  if (basics.name) doc.addNameLine(basics.name);
  if (basics.contact.length > 0) doc.addContactLine(basics.contact.map((item) => item.value).join(" · "));

  for (const paragraph of args.content.paragraphs) {
    if (!paragraph.text.trim()) continue;
    doc.addBodyParagraph(paragraph.text);
  }

  return { bytes: await doc.toBytes(), pageCount: doc.pageCount };
}
