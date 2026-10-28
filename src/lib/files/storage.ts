import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { normalizeText } from "@/lib/text/normalize";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (FR-001)

export const ACCEPTED_MIME_TYPES: Record<string, "pdf" | "docx"> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export function extensionFor(mimeType: string): "pdf" | "docx" {
  const kind = ACCEPTED_MIME_TYPES[mimeType];
  if (!kind) {
    throw new ApiError(
      "UNSUPPORTED_FORMAT",
      "Unsupported file format. Please upload a PDF or DOCX file.",
    );
  }
  return kind;
}

export async function saveUpload(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ storagePath: string; sha256: string; sizeBytes: number }> {
  if (bytes.byteLength === 0) throw new ApiError("CORRUPT_FILE", "The uploaded file is empty.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      "FILE_TOO_LARGE",
      `File exceeds the 10 MB limit (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB).`,
    );
  }
  const kind = extensionFor(mimeType);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = process.env.UPLOADS_DIR ?? "./uploads";
  await mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${sha256}.${kind}`);
  await writeFile(storagePath, bytes);
  return { storagePath, sha256, sizeBytes: bytes.byteLength };
}

/** Case- and accent-insensitive normalization — shared definition, see lib/text/normalize.ts. */
export const normalizeName = normalizeText;
