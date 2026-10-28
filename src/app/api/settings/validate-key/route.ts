import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { resolveKey, validateKeyAgainstOpenRouter } from "@/lib/settings/keyStore";

const BodySchema = z.object({ key: z.string().min(20).optional() });

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = BodySchema.parse(await req.json().catch(() => ({})));
    let key = body.key;
    if (!key) {
      const resolution = await resolveKey(user.id);
      key = resolution.key ?? undefined;
    }
    if (!key) {
      return NextResponse.json({ valid: false, reason: "missing", message: "No key configured." });
    }
    const result = await validateKeyAgainstOpenRouter(key);
    if (result.valid) {
      return NextResponse.json({ valid: true, label: result.label ?? null });
    }
    const messages = {
      invalid: "The key was rejected by OpenRouter — check for typos.",
      quota: "The key is valid but has no remaining credit.",
      unavailable: "Could not reach OpenRouter — try again shortly.",
    } as const;
    return NextResponse.json({ valid: false, reason: result.reason, message: messages[result.reason] });
  } catch (err) {
    return errorResponse(err);
  }
}
