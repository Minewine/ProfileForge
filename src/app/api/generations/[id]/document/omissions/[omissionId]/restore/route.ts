import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getVersionForJob, getJob, updateVersionContent } from "@/lib/generation/repository";
import { CoverLetterContentSchema, GeneratedCVContentSchema, type Omission } from "@/lib/generation/schemas";

type Params = { params: Promise<{ id: string; omissionId: string }> };

/** Mark an omission `restoredMustInclude: true` on the current version
 *  (contracts/api.md): applies at the next regeneration, where the item joins
 *  the must-include set — a `PAGE_BUDGET_CONFLICT` job failure there is the
 *  explicit conflict path (SC-006, never silent re-omission). */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id, omissionId } = await params;
    const job = await getJob(user.id, id); // 404 unknown/not owned + stale-running sweep
    if (job.status !== "succeeded") {
      throw new ApiError(
        "GENERATION_INVALID_STATE",
        `Omissions can only be restored on a succeeded generation (current status: "${job.status}").`,
        { status: job.status },
      );
    }
    const document = await db.generatedDocument.findUnique({
      where: { analysisId_kind: { analysisId: job.analysisId, kind: job.kind } },
    });
    const version = document ? await getVersionForJob(id, document.id) : null;
    if (!document || !version) {
      throw new ApiError("GENERATION_INVALID_STATE", "This generation has no document version yet.");
    }

    const parsed =
      job.kind === "cover_letter"
        ? CoverLetterContentSchema.safeParse(version.content)
        : GeneratedCVContentSchema.safeParse(version.content);
    if (!parsed.success) {
      throw new ApiError("GENERATION_INVALID_STATE", "The stored document content is unreadable.");
    }
    if (!parsed.data.omissions.some((o) => o.id === omissionId)) {
      throw new ApiError("OMISSION_NOT_FOUND", `No omission "${omissionId}" in the current version.`);
    }

    const omissions: Omission[] = parsed.data.omissions.map((o) =>
      o.id === omissionId ? { ...o, restoredMustInclude: true } : o,
    );
    await updateVersionContent(version.id, { content: { ...parsed.data, omissions } });
    return NextResponse.json({ omissions });
  } catch (err) {
    return errorResponse(err);
  }
}
