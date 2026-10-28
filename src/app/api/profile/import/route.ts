import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { getOrCreateProfile, importFromDraft, updateBasics, type SectionPayloads } from "@/lib/profile/repository";
import type { Basics } from "@/lib/validation/schemas";

const BodySchema = z.object({
  sourceDocumentId: z.string().min(1),
  mode: z.enum(["replace_parsed", "merge"]).default("replace_parsed"),
});

type StoredParseResult = {
  draft: unknown;
  prepared: SectionPayloads;
  flags: Array<{ code: string; detail: string }>;
  language: "fr" | "en";
};

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = BodySchema.parse(await req.json());
    const doc = await db.sourceDocument.findFirst({ where: { id: body.sourceDocumentId, userId: user.id } });
    if (!doc) throw new ApiError("NOT_FOUND", "Source document not found.");
    if (doc.parseStatus !== "parsed" || !doc.parseResult) {
      throw new ApiError("PARSE_FAILED", "This document has not been successfully parsed yet — run the parse first.");
    }

    const parsed = doc.parseResult as unknown as StoredParseResult;
    const language = (doc.detectedLanguage as "fr" | "en") ?? parsed.language ?? "en";

    // Carry over basics (name/contact) from the draft without clobbering existing values.
    const draftBasics = (parsed.draft as { basics?: Partial<Basics> | null } | null)?.basics;
    if (draftBasics && Object.keys(draftBasics).length > 0) {
      const profile = await getOrCreateProfile(user.id, language);
      const current = (profile.basics ?? {}) as Partial<Basics>;
      const merged = { ...current, ...cleanNullish(draftBasics) } as Partial<Basics>;
      if (merged.name) {
        await updateBasics(user.id, { basics: merged as Basics });
      }
    }

    const result = await importFromDraft(user.id, doc.id, language, parsed.prepared, body.mode);

    return NextResponse.json({
      sourceDocumentId: doc.id,
      mode: body.mode,
      ...result,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function cleanNullish<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) out[k] = v;
  }
  return out as Partial<T>;
}
