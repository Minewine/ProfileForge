import { unlink } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { LanguageCodeSchema } from "@/lib/validation/schemas";
import { entriesReferencingDocument } from "@/lib/profile/repository";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({ language: LanguageCodeSchema });

/** FR-030 / US1-scenario 6: correct a misdetected language before parsing. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = PatchSchema.parse(await req.json());
    const doc = await db.sourceDocument.findFirst({ where: { id, userId: user.id } });
    if (!doc) throw new ApiError("NOT_FOUND", "Source document not found.");
    const updated = await db.sourceDocument.update({
      where: { id },
      data: { detectedLanguage: body.language, languageManuallyCorrected: true },
    });
    return NextResponse.json({ sourceDocumentId: id, detectedLanguage: updated.detectedLanguage });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete with referential protection — provenance must never dangle (F5). */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const doc = await db.sourceDocument.findFirst({ where: { id, userId: user.id } });
    if (!doc) throw new ApiError("NOT_FOUND", "Source document not found.");

    const affectedEntryIds = await entriesReferencingDocument(id);
    if (affectedEntryIds.length > 0) {
      throw new ApiError(
        "SOURCE_IN_USE",
        "This document's content is referenced by profile entries. Re-attribute or delete those entries first.",
        { affectedEntryIds },
      );
    }

    await db.sourceDocument.delete({ where: { id } });
    await unlink(doc.storagePath).catch(() => undefined);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
