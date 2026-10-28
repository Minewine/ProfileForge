import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import "@/lib/llm/tasks/parsecv";
import { callLLM } from "@/lib/llm/router";
import { prepareDraft } from "@/lib/profile/prepareDraft";
import type { ProfileDraft } from "@/lib/validation/schemas";

type Params = { params: Promise<{ id: string }> };
type ExtractedEntry = { page?: number; paragraphIndex?: number; text: string };

const BodySchema = z.object({ confirmPartial: z.boolean().optional() });

const PARTIAL_PAGE_LIMIT = 10;
const PARTIAL_CHAR_LIMIT = 60_000;

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = BodySchema.parse(await req.json().catch(() => ({})));

    const doc = await db.sourceDocument.findFirst({ where: { id, userId: user.id } });
    if (!doc) throw new ApiError("NOT_FOUND", "Source document not found.");

    if (doc.requiresPartialParseConfirmation && body.confirmPartial !== true) {
      throw new ApiError(
        "CONFIRMATION_REQUIRED",
        "This CV is longer than 10 pages (or 60,000 characters). Only the first 10 pages will be parsed — confirm to proceed with a partial parse.",
      );
    }

    const extracted = (doc.extractedPages as unknown as ExtractedEntry[]) ?? [];
    const partial = doc.requiresPartialParseConfirmation;

    let included = extracted;
    let omittedPages: number[] | undefined;
    if (partial) {
      if (doc.pageCount != null) {
        included = extracted.filter((e) => (e.page ?? 0) <= PARTIAL_PAGE_LIMIT);
        omittedPages = extracted
          .map((e) => e.page)
          .filter((p): p is number => p != null && p > PARTIAL_PAGE_LIMIT);
      } else {
        // DOCX or char-limited: include leading paragraphs up to the char budget
        let budget = PARTIAL_CHAR_LIMIT;
        included = [];
        for (const e of extracted) {
          if (budget <= 0) break;
          included.push(e);
          budget -= e.text.length;
        }
      }
    }

    const markedText = included
      .map((e) =>
        e.page != null ? `<<<PAGE ${e.page}>>>\n${e.text}` : `¶${e.paragraphIndex} ${e.text}`,
      )
      .join("\n");

    const language = doc.detectedLanguage as "fr" | "en";
    await db.sourceDocument.update({ where: { id }, data: { parseStatus: "parsing", parseError: null } });

    try {
      const result = await callLLM<ProfileDraft>({
        userId: user.id,
        task: "parseCV",
        payload: { text: markedText, language },
      });
      const { enrichedDraft, prepared, flags } = prepareDraft(
        result.data,
        id,
        language,
        included.map((e) => e.text).join("\n"),
      );

      await db.sourceDocument.update({
        where: { id },
        data: {
          parseStatus: "parsed",
          parseResult: { draft: enrichedDraft, prepared, flags, language } as unknown as object,
        },
      });

      return NextResponse.json({
        parseStatus: "parsed",
        draft: enrichedDraft,
        flags,
        ...(partial ? { partial: true as const, omittedPages: omittedPages ?? [] } : {}),
        usage: result.usage,
      });
    } catch (err) {
      await db.sourceDocument.update({
        where: { id },
        data: {
          parseStatus: "failed",
          parseError: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
