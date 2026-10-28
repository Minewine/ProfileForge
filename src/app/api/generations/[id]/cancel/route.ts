import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getJob, setCancelRequested } from "@/lib/generation/repository";

type Params = { params: Promise<{ id: string }> };

/** Set cancelRequested; the pipeline lands `cancelled` at the next stage boundary. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    await getJob(user.id, id); // 404 + stale sweep + ownership
    const updated = await setCancelRequested(id); // 409 GENERATION_INVALID_STATE from terminal states
    return NextResponse.json({ status: updated.status });
  } catch (err) {
    return errorResponse(err);
  }
}
