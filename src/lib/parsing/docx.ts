import mammoth from "mammoth";

export type ExtractedParagraph = { paragraphIndex: number; text: string };

/** Paragraph-level DOCX extraction (locators are paragraph indexes). */
export async function extractDocxParagraphs(bytes: Uint8Array): Promise<ExtractedParagraph[]> {
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value
    .split(/\r?\n/)
    .map((text, paragraphIndex) => ({ paragraphIndex, text: text.trim() }));
}
