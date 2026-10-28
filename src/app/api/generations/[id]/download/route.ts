import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getVersionForJob, getJob } from "@/lib/generation/repository";
import { factGuardGate } from "@/lib/generation/factguard";
import { readArtifactBytes } from "@/lib/generation/artifacts";
import { ArtifactMetaSchema, ValidationReportSchema } from "@/lib/generation/schemas";
import { generationArtifactDir } from "@/lib/generation/artifacts";
import path from "node:path";

type Params = { params: Promise<{ id: string }> };

const QuerySchema = z.object({ format: z.enum(["pdf", "docx", "txt"]).default("pdf") });

const CONTENT_TYPES: Record<"pdf" | "docx" | "txt", string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
};

/**
 * Gated download (contracts/api.md): succeeded job with a version (409
 * GENERATION_INVALID_STATE) → Fact Guard fail-closed gate (409
 * FACTGUARD_UNAVAILABLE when the semantic layer did not run) → no pending
 * blockers (403 BLOCKERS_UNRESOLVED + flag summary) → format constraints:
 * `pdf` additionally requires `extractionCheck.passed` (409 EXPORT_GATE_FAILED
 * with the stored results otherwise); `docx`/`txt` are ungated by extraction
 * (parent exception) but blocker-gated like every artifact. 200 streams the
 * file with `Content-Disposition: attachment; filename="{kind}-v{version}.{ext}"`.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    await connection(); // req.url access must stay dynamic (cacheComponents)
    const { id } = await params;
    const { format } = QuerySchema.parse({ format: new URL(req.url).searchParams.get("format") ?? undefined });

    const job = await getJob(user.id, id); // 404 unknown, not owned, + stale-running sweep
    if (job.status !== "succeeded") {
      throw new ApiError(
        "GENERATION_INVALID_STATE",
        `Downloads require a succeeded generation job (current status: "${job.status}").`,
        { status: job.status },
      );
    }
    const document = await db.generatedDocument.findUnique({
      where: { analysisId_kind: { analysisId: job.analysisId, kind: job.kind } },
    });
    const version = document ? await getVersionForJob(id, document.id) : null;
    if (!version) {
      throw new ApiError("GENERATION_INVALID_STATE", "No document version was produced for this job.");
    }

    const parsedReport = ValidationReportSchema.safeParse(version.validationReport);
    if (!parsedReport.success) {
      throw new ApiError("GENERATION_INVALID_STATE", "The stored validation report is unreadable — cannot open the gate.");
    }
    const gate = factGuardGate(parsedReport.data);
    if (gate.reason === "FACTGUARD_UNAVAILABLE") {
      // fail-closed (FR-010): the report is incomplete even with zero flags —
      // the deterministic flags stay visible in the details
      throw new ApiError(
        "FACTGUARD_UNAVAILABLE",
        "The Fact Guard semantic layer did not run for this version — download is blocked until validation succeeds. Edit any claim to re-validate.",
        { summary: parsedReport.data.summary, flags: parsedReport.data.flags },
      );
    }
    if (gate.reason === "BLOCKERS_UNRESOLVED") {
      throw new ApiError("BLOCKERS_UNRESOLVED", "Every blocking claim must be resolved or confirmed before download.", {
        summary: parsedReport.data.summary,
        flags: gate.pendingBlockers,
      });
    }

    // format constraints (R12 gate matrix)
    const extraction = version.extractionCheck as { passed?: boolean } | null;
    if (format === "pdf" && extraction?.passed !== true) {
      // artifacts are only written after passing — a failed-gate version has
      // no PDF to serve and reports the stored check results instead
      throw new ApiError("EXPORT_GATE_FAILED", "The rendered PDF failed the extraction gate and was never stored.", {
        extractionCheck: version.extractionCheck ?? null,
      });
    }

    const artifacts = ArtifactMetaSchema.array().catch([]).parse(version.artifacts ?? []);
    const artifact = artifacts.find((a) => a.format === format);
    if (!artifact) {
      // `txt` arrives with cover letters (US6); a cv has no plain-text artifact
      throw new ApiError("GENERATION_INVALID_STATE", `No ${format} artifact exists for this version yet.`);
    }

    // Defense in depth: only read files inside this version's artifact dir
    // (the JSONB storagePath is written by the pipeline today, but never trusted).
    const allowedDir = path.resolve(generationArtifactDir(version.id));
    if (!path.resolve(artifact.storagePath).startsWith(allowedDir + path.sep)) {
      throw new ApiError("GENERATION_INVALID_STATE", "The stored artifact path is invalid.");
    }
    const bytes = await readArtifactBytes(artifact.storagePath);
    const stem = job.kind === "cover_letter" ? "letter" : "cv";
    return new Response(bytes, {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${stem}-v${version.version}.${format}"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
