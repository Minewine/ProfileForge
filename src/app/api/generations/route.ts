import { NextResponse, connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getAnalysis } from "@/lib/jobs/repository";
import { kickoffGenerationJob } from "@/lib/generation/pipeline";
import { createGenerationJob, ensureDocument, listByAnalysis } from "@/lib/generation/repository";
import { GenerationCreateSchema, resolveGenerationSettings } from "@/lib/generation/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = GenerationCreateSchema.parse(await req.json());
    const analysis = await getAnalysis(user.id, body.analysisId); // 404 when unknown or not owned
    const settings = resolveGenerationSettings({
      kind: body.kind,
      analysisLanguage: analysis.language,
      input: body.settings,
    });
    const job = await createGenerationJob(user.id, { analysisId: analysis.id, kind: body.kind, settings });
    const document = await ensureDocument(analysis.id, body.kind);
    kickoffGenerationJob(job.id); // async execution — the 202 returns immediately
    return NextResponse.json(
      { generationJobId: job.id, status: job.status, documentId: document.id, settings },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

const ListQuerySchema = z.object({ analysisId: z.string().min(1) });

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    await connection(); // req.url access must stay dynamic (cacheComponents)
    const query = ListQuerySchema.parse({
      analysisId: new URL(req.url).searchParams.get("analysisId"),
    });
    await getAnalysis(user.id, query.analysisId); // ownership gate — NOT_FOUND when not the owner's
    return NextResponse.json({ generations: await listByAnalysis(query.analysisId) });
  } catch (err) {
    return errorResponse(err);
  }
}
