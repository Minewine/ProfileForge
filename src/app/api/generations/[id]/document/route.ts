import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { computeDownloadable, getVersionForJob, getJob } from "@/lib/generation/repository";
import {
  ArtifactMetaSchema,
  CoverLetterContentSchema,
  GeneratedCVContentSchema,
  ValidationReportSchema,
} from "@/lib/generation/schemas";

type Params = { params: Promise<{ id: string }> };

/** The claim-review UI's data source (contracts/api.md): the full current
 *  version — content, validation flags, omissions, gate results. 409
 *  GENERATION_INVALID_STATE while the job has not succeeded. */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const job = await getJob(user.id, id); // 404 unknown/not owned + stale-running sweep (R4)
    if (job.status !== "succeeded") {
      throw new ApiError(
        "GENERATION_INVALID_STATE",
        `The document is unavailable while the generation job is "${job.status}".`,
        { status: job.status },
      );
    }
    const document = await db.generatedDocument.findUnique({
      where: { analysisId_kind: { analysisId: job.analysisId, kind: job.kind } },
    });
    const version = document ? await getVersionForJob(id, document.id) : null;
    if (!version) throw new ApiError("NOT_FOUND", "This generation has no document version yet.");

    const parsedContent =
      job.kind === "cover_letter"
        ? CoverLetterContentSchema.safeParse(version.content)
        : GeneratedCVContentSchema.safeParse(version.content);
    if (!parsedContent.success) {
      throw new ApiError("GENERATION_INVALID_STATE", "The stored document content is unreadable.");
    }
    const parsedReport = ValidationReportSchema.safeParse(version.validationReport);
    if (!parsedReport.success) {
      throw new ApiError("GENERATION_INVALID_STATE", "The stored validation report is unreadable.");
    }

    return NextResponse.json({
      version: version.version,
      revision: version.revision,
      content: parsedContent.data,
      validationReport: parsedReport.data,
      selection: version.selection ?? null, // feature 005 SelectionRecord — null for pre-feature versions
      omissions: parsedContent.data.omissions, // omissions live inside the content
      artifacts: ArtifactMetaSchema.array().catch([]).parse(version.artifacts ?? []),
      canDownload: computeDownloadable(version),
      ...(version.extractionCheck ? { extractionCheck: version.extractionCheck } : {}),
      ...(job.notice ? { notice: job.notice } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
