import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getAnalysis, persistReport } from "@/lib/jobs/repository";
import type { MatchReport, MatchReportExtras } from "@/lib/jobs/schemas";
import { getProfile } from "@/lib/profile/repository";
import { matchRequirements, deriveKeywords } from "@/lib/matching/engine";
import { buildProfileDigest } from "@/lib/matching/digest";
import { scoreReport } from "@/lib/matching/score";
import "@/lib/llm/tasks/semanticproposals";
import { callLLM } from "@/lib/llm/router";

type Params = { params: Promise<{ id: string }> };

const BodySchema = z.object({ recompute: z.boolean().optional() });

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body =
      req && typeof req.json === "function"
        ? BodySchema.parse(await req.json().catch(() => ({})))
        : {};
    const analysis = await getAnalysis(user.id, id);

    if (analysis.status === "matched" && body.recompute !== true) {
      throw new ApiError(
        "INVALID_STATE",
        "This analysis already has a stored report. Pass recompute to replace it in place, or use /rerun for a new chained analysis.",
      );
    }
    if (analysis.status !== "finalized" && analysis.status !== "matched") {
      throw new ApiError(
        "INVALID_STATE",
        `Match requires a finalized requirement list (current status: "${analysis.status}").`,
      );
    }

    const profile = await getProfile(user.id);
    const requirements = analysis.requirements.map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      importance: r.importance,
      isHardConstraint: r.isHardConstraint,
      userConfirmed: r.userConfirmed,
    }));

    // deterministic layers first (exact → alias)
    const pass1 = matchRequirements(requirements, profile, null);

    // semantic step (non-hard, unmatched only) — evidence-validated afterwards
    const runId = `match-${id}-${Date.now()}`;
    let proposals: Array<{ requirementIndex: number; entryIds: string[]; rationale?: string }> | null = null;
    let notice: string | null = null;
    let usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };

    if (pass1.unmatchedNonHard.length > 0) {
      const digest = buildProfileDigest(profile);
      if (digest.length > 0) {
        try {
          const result = await callLLM<{
            proposals: Array<{ requirementIndex: number; entryIds: string[]; rationale?: string }>;
          }>({
            userId: user.id,
            task: "semanticProposals",
            payload: {
              language: analysis.language,
              requirements: pass1.unmatchedNonHard,
              profileDigest: digest,
            },
            runId,
          });
          proposals = result.data.proposals;
          usage = result.usage;
        } catch {
          // FR-014: degrade to exact/alias-only, visible notice — never block, never fabricate
          notice = "semantic-matching-unavailable";
        }
      }
    }

    const final = matchRequirements(requirements, profile, proposals);
    const { overallScore, scoreBreakdown } = scoreReport(final.matches);
    const keywords = deriveKeywords(final.matches);

    const report = {
      overallScore,
      scoreBreakdown,
      requirements: final.matches,
      recommendedKeywords: keywords.recommended,
      missingKeywords: keywords.missing,
      semanticDropped: final.semanticDropped,
      // slice extension (documented): hard constraints with semantic proposals → confirmable
      confirmable: final.confirmable,
    } satisfies MatchReport & MatchReportExtras;

    await persistReport(user.id, id, profile.version, report, { recompute: body.recompute, notice });

    return NextResponse.json({
      status: "matched",
      report,
      profileVersion: profile.version,
      usage,
      semanticDropped: final.semanticDropped,
      ...(notice ? { notice } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
