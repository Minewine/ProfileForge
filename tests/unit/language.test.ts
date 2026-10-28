import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectLanguage } from "@/lib/parsing/language";
import { extractPdfPages } from "@/lib/parsing/pdf";
import { extractDocxParagraphs } from "@/lib/parsing/docx";

const FIXTURES = path.resolve("tests/fixtures");

describe("language detection (franc, deterministic)", () => {
  it("detects English and French PDFs", async () => {
    const enPages = await extractPdfPages(readFileSync(path.join(FIXTURES, "cv-en.pdf")));
    const frPages = await extractPdfPages(readFileSync(path.join(FIXTURES, "cv-fr.pdf")));
    expect(detectLanguage(pagesToText(enPages)).language).toBe("en");
    expect(detectLanguage(pagesToText(frPages)).language).toBe("fr");
  });

  it("marks very short text as low-confidence", () => {
    const result = detectLanguage("John Smith email phone");
    expect(result.confident).toBe(false);
  });

  it("extracts DOCX paragraphs with structure preserved", async () => {
    const paragraphs = await extractDocxParagraphs(readFileSync(path.join(FIXTURES, "cv-fr.docx")));
    expect(paragraphs.length).toBeGreaterThan(10);
    expect(paragraphs[0].text).toContain("Camille Durand");
    const all = paragraphs.map((p) => p.text).join(" ");
    expect(detectLanguage(all).language).toBe("fr");
  });
});

function pagesToText(pages: Array<{ text: string }>): string {
  return pages.map((p) => p.text).join("\n");
}
