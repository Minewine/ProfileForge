import { NextResponse } from "next/server";
import type { z } from "zod";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getAnalysis, markExtractFailed, storeExtractedRequirements } from "@/lib/jobs/repository";
import "@/lib/llm/tasks/extractrequirements";
import { callLLM } from "@/lib/llm/router";
import { ExtractRequirementsOutputSchema } from "@/lib/llm/tasks/extractrequirements";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const user = await requireUser();
    const analysis = await getAnalysis(user.id, id);

    try {
      const result = await callLLM<z.infer<typeof ExtractRequirementsOutputSchema>>({
        userId: user.id,
        task: "extractRequirements",
        payload: { text: analysis.jdText, language: analysis.language },
        runId: `extract-${id}-${Date.now()}`,
      });

      const stored = await storeExtractedRequirements(user.id, id, result.data.requirements);
      return NextResponse.json({
        status: "extracted",
        requirements: stored.requirements,
        replacedRequirements: stored.replacedRequirements,
        usage: result.usage,
      });
    } catch (err) {
      // LLM/system failures mark the analysis failed-but-retryable (FR-014: JD preserved)
      if (!(err instanceof ApiError) || err.code.startsWith("LLM_")) {
        await markExtractFailed(user.id, id, err instanceof Error ? err.message : String(err)).catch(
          () => undefined,
        );
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
