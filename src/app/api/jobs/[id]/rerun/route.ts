import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { rerunAnalysis } from "@/lib/jobs/repository";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const analysisId = await rerunAnalysis(user.id, id);
    return NextResponse.json({ analysisId }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
