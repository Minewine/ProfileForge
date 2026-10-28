import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { kickoffGenerationJob } from "@/lib/generation/pipeline";
import { retryJob, getJob } from "@/lib/generation/repository";

type Params = { params: Promise<{ id: string }> };

/** Re-enqueue a failed/cancelled job: attempt + 1, fresh runId, back to queued. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    await getJob(user.id, id); // ownership gate — NOT_FOUND when unknown or not the owner's
    const retried = await retryJob(id); // 409 unless failed/cancelled
    kickoffGenerationJob(id); // start the new attempt without awaiting
    return NextResponse.json({ generationJobId: retried.id, attempt: retried.attempt }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
