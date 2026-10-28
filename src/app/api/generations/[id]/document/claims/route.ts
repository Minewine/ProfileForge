import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import {
  findConfirmedFingerprints,
  getVersionForJob,
  getJob,
  updateVersionContent,
} from "@/lib/generation/repository";
import { revalidateVersionClaims, removeClaim, setClaimText } from "@/lib/generation/factguard";
import {
  CoverLetterContentSchema,
  GeneratedCVContentSchema,
  GenerationSettingsSchema,
  ValidationReportSchema,
  type CoverLetterContent,
  type GeneratedCVContent,
  type ValidationReport,
} from "@/lib/generation/schemas";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  claimId: z.string().min(1),
  text: z.string().trim().min(1).max(2000),
});
const DeleteSchema = z.object({ claimId: z.string().min(1) });

/** Resolve the succeeded job's current version for claim resolution. */
async function loadEditableVersion(userId: string, jobId: string) {
  const job = await getJob(userId, jobId); // 404 unknown/not owned + stale-running sweep
  if (job.status !== "succeeded") {
    throw new ApiError(
      "GENERATION_INVALID_STATE",
      `Claims can only be resolved on a succeeded generation (current status: "${job.status}").`,
      { status: job.status },
    );
  }
  const document = await db.generatedDocument.findUnique({
    where: { analysisId_kind: { analysisId: job.analysisId, kind: job.kind } },
  });
  const version = document ? await getVersionForJob(jobId, document.id) : null;
  if (!document || !version) {
    throw new ApiError("GENERATION_INVALID_STATE", "This generation has no document version to edit.");
  }
  return { job, documentId: document.id, version };
}

function parseVersionPayloads(
  kind: string,
  version: { content: unknown; validationReport: unknown },
): {
  content: GeneratedCVContent | CoverLetterContent;
  priorReport: ValidationReport;
} {
  const parsed =
    kind === "cover_letter"
      ? CoverLetterContentSchema.safeParse(version.content)
      : GeneratedCVContentSchema.safeParse(version.content);
  const report = ValidationReportSchema.safeParse(version.validationReport);
  if (!parsed.success || !report.success) {
    throw new ApiError("GENERATION_INVALID_STATE", "The stored version content or validation report is unreadable.");
  }
  return { content: parsed.data, priorReport: report.data };
}

/** Edit a claim's text on the current version (structured content, never the
 *  rendered artifact): re-run both Fact Guard layers, rewrite the report, bump
 *  the revision. On a semantic-layer outage the edit is still stored with
 *  resolution `edited`, deterministic flags refresh, and the response is 409
 *  FACTGUARD_UNAVAILABLE (download stays blocked, fail-closed). */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = PatchSchema.parse(await req.json());
    const { job, documentId, version } = await loadEditableVersion(user.id, id);
    const { content, priorReport } = parseVersionPayloads(job.kind, version);

    const edited = setClaimText(content, body.claimId, body.text);
    if (!edited) throw new ApiError("CLAIM_NOT_FOUND", `No claim "${body.claimId}" in the current version.`);

    const { report, semanticAvailable } = await revalidateVersionClaims({
      userId: user.id,
      analysisId: job.analysisId,
      profileVersion: job.profileVersion,
      settings: GenerationSettingsSchema.parse(job.settings),
      content: edited,
      priorReport,
      editedClaimId: body.claimId,
      confirmedFingerprints: await findConfirmedFingerprints(documentId),
    });
    await updateVersionContent(version.id, { content: edited, validationReport: report }); // revision + 1
    if (!semanticAvailable) {
      throw new ApiError(
        "FACTGUARD_UNAVAILABLE",
        "Claim edit stored, but the Fact Guard semantic layer is unavailable — deterministic flags were refreshed and download stays blocked.",
        { validationReport: report },
      );
    }
    return NextResponse.json({ validationReport: report });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Remove a claim block: flag resolution `removed`, re-validate the remaining
 *  content, bump the revision. */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = DeleteSchema.parse(await req.json());
    const { job, documentId, version } = await loadEditableVersion(user.id, id);
    const { content, priorReport } = parseVersionPayloads(job.kind, version);

    const reduced = removeClaim(content, body.claimId);
    if (!reduced) throw new ApiError("CLAIM_NOT_FOUND", `No claim "${body.claimId}" in the current version.`);

    const { report, semanticAvailable } = await revalidateVersionClaims({
      userId: user.id,
      analysisId: job.analysisId,
      profileVersion: job.profileVersion,
      settings: GenerationSettingsSchema.parse(job.settings),
      content: reduced,
      priorReport,
      removedClaimId: body.claimId,
      confirmedFingerprints: await findConfirmedFingerprints(documentId),
    });
    await updateVersionContent(version.id, { content: reduced, validationReport: report }); // revision + 1
    if (!semanticAvailable) {
      throw new ApiError(
        "FACTGUARD_UNAVAILABLE",
        "Claim removed, but the Fact Guard semantic layer is unavailable — deterministic flags were refreshed and download stays blocked.",
        { validationReport: report },
      );
    }
    return NextResponse.json({ validationReport: report });
  } catch (err) {
    return errorResponse(err);
  }
}
