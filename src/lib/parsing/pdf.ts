import { extractText, getDocumentProxy } from "unpdf";

export type ExtractedPage = { page: number; text: string };

/** Per-page text extraction (provenance locators need page numbers). */
export async function extractPdfPages(bytes: Uint8Array): Promise<ExtractedPage[]> {
  // pdf.js requires a plain Uint8Array — a Node Buffer is rejected.
  const data = bytes instanceof Uint8Array && bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes);
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => ({ page: i + 1, text: t ?? "" }));
}
