import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getProfile, updateBasics } from "@/lib/profile/repository";
import { BasicsSchema, LanguageCodeSchema } from "@/lib/validation/schemas";

export async function GET() {
  try {
    const user = await requireUser();
    const profile = await getProfile(user.id);
    const awaitingDraft = await db.sourceDocument.findFirst({
      where: { userId: user.id, parseStatus: "parsed", importedAt: null },
      select: { id: true },
    });
    return NextResponse.json({
      profile,
      lowConfidenceCount: profile.lowConfidenceCount,
      hasDraftAwaitingImport: awaitingDraft !== null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchSchema = z.object({
  basics: BasicsSchema.optional(),
  language: LanguageCodeSchema.optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = PatchSchema.parse(await req.json());
    const result = await updateBasics(user.id, body);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
