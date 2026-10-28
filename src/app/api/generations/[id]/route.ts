import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getDocumentSummaryFor, getJob, getRunUsage } from "@/lib/generation/repository";
import type { GenerationKind } from "@/lib/generation/schemas";

type Params = { params: Promise<{ id: string }> };

/** Polling endpoint: job status + live document gate summary + run usage. */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const job = await getJob(user.id, id); // also sweeps stale running rows (research R4)
    const document = await getDocumentSummaryFor(job.analysisId, job.kind as GenerationKind, {
      forJobId: job.id,
    });
    return NextResponse.json({
      job: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        statusError: job.statusError,
        attempt: job.attempt,
        runId: job.runId,
        profileVersion: job.profileVersion,
        notice: job.notice,
        settings: job.settings,
      },
      document,
      ...(job.runId ? { usage: await getRunUsage(job.runId) } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
