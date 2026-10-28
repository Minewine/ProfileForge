import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getAnalysis, persistReport } from "@/lib/jobs/repository";
import type { MatchReport, MatchReportExtras } from "@/lib/jobs/schemas";
import { getProfile } from "@/lib/profile/repository";
import { buildEvidenceIndex, deriveKeywords } from "@/lib/matching/engine";
import { scoreReport } from "@/lib/matching/score";

type Params = { params: Promise<{ id: string }> };

const BodySchema = z.object({ requirementId: z.string().min(1) });

/**
 * Evidence-gated confirmation (FR-007): a hard constraint can be marked met via
 * semantic evidence ONLY if the match run recorded a semantic proposal for it.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = BodySchema.parse(await req.json());
    const analysis = await getAnalysis(user.id, id);

    if (analysis.status !== "matched" || !analysis.matchReport) {
      throw new ApiError("INVALID_STATE", "Confirmation requires a matched analysis.");
    }
    const report = analysis.matchReport as unknown as MatchReportExtras & MatchReport;
    const entryIds = report.confirmable?.[body.requirementId];
    if (!entryIds || entryIds.length === 0) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "This requirement has no recorded semantic evidence to confirm — a hard constraint cannot be confirmed without it.",
      );
    }

    // requirement rows carry no owner of their own — reached only through the analysis root
    if (!analysis.requirements.some((r) => r.id === body.requirementId)) {
      throw new ApiError("NOT_FOUND", "Requirement not found in this analysis.");
    }

    // record the confirmation on the requirement row (persists across replaces and re-runs)
    await db.jobRequirement.update({
      where: { id: body.requirementId },
      data: { userConfirmed: true },
    });

    // flip the stored report entry + recompute the score
    const profile = await getProfile(user.id);
    const evidenceIndex = buildEvidenceIndex(profile);
    const evidence = entryIds
      .map((entryId) => evidenceIndex.get(entryId))
      .filter((e): e is NonNullable<typeof e> => e != null);

    const updated = {
      ...report,
      requirements: report.requirements.map((m) =>
        m.id === body.requirementId
          ? { ...m, status: "strong" as const, matchMethod: "semantic" as const, userConfirmed: true, evidence }
          : m,
      ),
      confirmable: Object.fromEntries(
        Object.entries(report.confirmable ?? {}).filter(([key]) => key !== body.requirementId),
      ),
    };
    const { overallScore, scoreBreakdown } = scoreReport(updated.requirements);
    const keywords = deriveKeywords(updated.requirements);
    const next = {
      ...updated,
      overallScore,
      scoreBreakdown,
      recommendedKeywords: keywords.recommended,
      missingKeywords: keywords.missing,
    };

    await persistReport(user.id, id, analysis.profileVersion ?? profile.version, next, { recompute: true });
    return NextResponse.json({ report: next });
  } catch (err) {
    return errorResponse(err);
  }
}
