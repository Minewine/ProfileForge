import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { saveUpload } from "@/lib/files/storage";
import { extractPdfPages } from "@/lib/parsing/pdf";
import { extractDocxParagraphs } from "@/lib/parsing/docx";
import { detectLanguage } from "@/lib/parsing/language";

const PARTIAL_PAGE_THRESHOLD = 10;
const PARTIAL_CHAR_THRESHOLD = 60_000;
const MIN_TEXT_CHARS = 50; // below this a "text-based" PDF is treated as scanned

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Missing 'file' field.", details: null } },
        { status: 400 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = await saveUpload(bytes, file.type); // guards size + MIME (FR-001)

    let extracted: Array<{ page: number; text: string } | { paragraphIndex: number; text: string }>;
    let pageCount: number | null = null;
    let paragraphCount: number | null = null;

    if (file.type === "application/pdf") {
      const pages = await extractPdfPages(bytes);
      pageCount = pages.length;
      extracted = pages;
    } else {
      const paragraphs = await extractDocxParagraphs(bytes);
      paragraphCount = paragraphs.length;
      extracted = paragraphs;
    }

    const allText = extracted.map((e) => e.text).join("\n");
    if (allText.replace(/\s+/g, "").length < MIN_TEXT_CHARS) {
      throw new ApiError(
        "NO_TEXT_LAYER",
        "No extractable text found — this looks like a scanned CV. Please upload a text-based PDF or a DOCX file.",
      );
    }

    const detection = detectLanguage(allText);
    const charCount = allText.length;
    const requiresPartial =
      (pageCount !== null && pageCount > PARTIAL_PAGE_THRESHOLD) || charCount > PARTIAL_CHAR_THRESHOLD;

    // Same file uploaded twice → return the existing document (sha256 dedupe,
    // scoped to the owner — identical files from different users stay separate).
    const existing = await db.sourceDocument.findFirst({
      where: { sha256: saved.sha256, userId: user.id },
    });
    const doc =
      existing ??
      (await db.sourceDocument.create({
        data: {
          userId: user.id,
          originalFilename: file.name,
          storagePath: saved.storagePath,
          sha256: saved.sha256,
          mimeType: file.type,
          sizeBytes: saved.sizeBytes,
          detectedLanguage: detection.language,
          pageCount,
          paragraphCount,
          extractedPages: extracted,
          charCount,
          requiresPartialParseConfirmation: requiresPartial,
        },
      }));

    return NextResponse.json({
      sourceDocumentId: doc.id,
      detectedLanguage: doc.detectedLanguage,
      languageLowConfidence: !detection.confident,
      pageCount: doc.pageCount,
      paragraphCount: doc.paragraphCount,
      charCount: doc.charCount,
      requiresPartialParseConfirmation: doc.requiresPartialParseConfirmation,
      parseStatus: doc.parseStatus,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
