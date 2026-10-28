import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import {
  getVersionForJob,
  getJob,
  recordConfirmation,
  setVersionValidationReport,
} from "@/lib/generation/repository";
import { applyConfirmation, findClaimEvidence } from "@/lib/generation/factguard";
import {
  CoverLetterContentSchema,
  GeneratedCVContentSchema,
  ValidationReportSchema,
  claimFingerprint,
} from "@/lib/generation/schemas";

type Params = { params: Promise<{ id: string; claimId: string }> };

/** Record `user_confirmed` with attribution and store the claim fingerprint on
 *  the document — identical claims in future versions auto-resolve (R10).
 *  Confirmations do not bump the revision (data-model). */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id, claimId } = await params;
    const job = await getJob(user.id, id); // 404 unknown/not owned + stale-running sweep
    if (job.status !== "succeeded") {
      throw new ApiError(
        "GENERATION_INVALID_STATE",
        `Claims can only be confirmed on a succeeded generation (current status: "${job.status}").`,
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

    const parsedContent =
      job.kind === "cover_letter"
        ? CoverLetterContentSchema.safeParse(version.content)
        : GeneratedCVContentSchema.safeParse(version.content);
    const parsedReport = ValidationReportSchema.safeParse(version.validationReport);
    if (!parsedContent.success || !parsedReport.success) {
      throw new ApiError("GENERATION_INVALID_STATE", "The stored version content or validation report is unreadable.");
    }
    const evidence = findClaimEvidence(parsedContent.data, claimId);
    if (!evidence) throw new ApiError("CLAIM_NOT_FOUND", `No claim "${claimId}" in the current version.`);

    const confirmedAt = new Date().toISOString();
    const report = applyConfirmation(parsedReport.data, claimId, confirmedAt);
    await recordConfirmation(document.id, {
      fingerprint: claimFingerprint(evidence.text, evidence.evidenceIds),
      confirmedAt,
    });
    await setVersionValidationReport(version.id, report); // no revision bump
    return NextResponse.json({ validationReport: report });
  } catch (err) {
    return errorResponse(err);
  }
}
