import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import type { ArtifactMeta, GenerationKind } from "@/lib/generation/schemas";

/**
 * Artifact storage (research R12): files under
 * `UPLOADS_DIR/generations/{versionId}/{cv|letter}.{pdf|docx|txt}` with
 * sha256 + byte size + gate outcome recorded in the version's `artifacts`
 * JSONB. The PDF is only written after the extraction gate passes (SC-003:
 * a failing artifact never exists at the download location).
 */

export function generationArtifactDir(versionId: string): string {
  return path.join(process.env.UPLOADS_DIR ?? "./uploads", "generations", versionId);
}

function fileStem(kind: GenerationKind): "cv" | "letter" {
  return kind === "cover_letter" ? "letter" : "cv";
}

/** Write the given artifacts for a version and return their metadata.
 *  `pdf` is only passed by the pipeline after `extractionCheck.passed`. */
export async function writeGenerationArtifacts(args: {
  versionId: string;
  kind: GenerationKind;
  pdf?: Uint8Array;
  docx?: Uint8Array;
  txt?: string;
}): Promise<ArtifactMeta[]> {
  const dir = generationArtifactDir(args.versionId);
  await mkdir(dir, { recursive: true });
  const stem = fileStem(args.kind);

  const metas: ArtifactMeta[] = [];
  const write = async (
    format: ArtifactMeta["format"],
    data: Uint8Array | string,
    gate: ArtifactMeta["gate"],
  ): Promise<void> => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const storagePath = path.join(dir, `${stem}.${format}`);
    await writeFile(storagePath, bytes);
    metas.push({
      format,
      storagePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      gate,
    });
  };

  // The PDF is the verified deliverable — its failure fails the caller. The
  // best-effort extras (docx/txt) are individually non-fatal (review P1-1):
  // a failed extra is skipped with a warning, never discarding the PDF.
  if (args.pdf !== undefined) await write("pdf", args.pdf, "verified");
  if (args.docx !== undefined) {
    try {
      await write("docx", args.docx, "best_effort");
    } catch (err) {
      console.warn(`docx artifact write skipped for ${args.versionId}: ${String(err)}`);
    }
  }
  if (args.txt !== undefined) {
    try {
      await write("txt", args.txt, "none");
    } catch (err) {
      console.warn(`txt artifact write skipped for ${args.versionId}: ${String(err)}`);
    }
  }
  return metas;
}

/** Read an artifact back for streaming (download route). Backed by a plain
 *  ArrayBuffer so the bytes satisfy `new Response(bytes)` (BodyInit). */
export async function readArtifactBytes(storagePath: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await readFile(storagePath));
  } catch {
    throw new ApiError("GENERATION_INVALID_STATE", "The stored artifact file is missing from disk — regenerate the document.");
  }
}
