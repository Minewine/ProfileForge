import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { createAnalysis, listAnalyses } from "@/lib/jobs/repository";
import { JobCreateSchema } from "@/lib/jobs/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = JobCreateSchema.parse(await req.json());
    const { analysis, languageLowConfidence } = await createAnalysis(user.id, body.text);
    return NextResponse.json(
      {
        analysisId: analysis.id,
        language: analysis.language,
        languageLowConfidence,
        status: analysis.status,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ analyses: await listAnalyses(user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}
