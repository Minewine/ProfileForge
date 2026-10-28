import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { resolveKey, saveKey, storedKeyHint, validateKeyAgainstOpenRouter } from "@/lib/settings/keyStore";
import { getSettings, updateSettings } from "@/lib/settings/store";
import { modelSupportsStructuredOutputs } from "@/lib/settings/models";

export async function GET() {
  try {
    const user = await requireUser();
    const settings = await getSettings(user.id);
    const resolution = await resolveKey(user.id);
    const recentUsage = await db.llmUsageLog.findMany({
      where: { userId: user.id }, // per-user usage only (specs/008 FR-008)
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { runId: true, task: true, model: true, costUsd: true, createdAt: true },
    });
    return NextResponse.json({
      keyConfigured: resolution.key !== null,
      keySource: resolution.source,
      keyHint: (await storedKeyHint(user.id)) ?? (resolution.key ? "env variable" : null),
      modelEconomy: settings.modelEconomy,
      modelPremium: settings.modelPremium,
      costCapUsd: settings.costCapUsd,
      usage: recentUsage.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const PutSettingsSchema = z.object({
  openRouterKey: z.string().min(20).optional(),
  modelEconomy: z.string().min(3).optional(),
  modelPremium: z.string().min(3).optional(),
  costCapUsd: z.number().gt(0).max(100).optional(),
});

export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = PutSettingsSchema.parse(await req.json());
    const warnings: Array<{ model: string; message: string }> = [];

    if (body.openRouterKey !== undefined) {
      const check = await validateKeyAgainstOpenRouter(body.openRouterKey);
      // Only a definitively invalid key (rejected auth) blocks saving.
      // Zero credit or an unreachable validator still saves — the key works
      // for :free models, and the outcome is reported as a warning.
      if (!check.valid && check.reason === "invalid") {
        throw new ApiError(
          "LLM_KEY_INVALID",
          "This key was rejected by OpenRouter. Double-check it and try again.",
        );
      }
      const savedHint = await saveKey(user.id, body.openRouterKey);
      if (!check.valid) {
        warnings.push({
          model: "openRouterKey",
          message:
            check.reason === "quota"
              ? "Key saved — it has no remaining credit, which is fine for :free models but paid models will fail until you top up."
              : "Key saved — OpenRouter could not be reached to verify it, so it was stored unverified.",
        });
      }
      return NextResponse.json({
        keySaved: true,
        keyHint: savedHint,
        keyValidation: check,
        warnings,
      });
    }

    // Models without native structured-output support are accepted — the router
    // degrades to prompt-only JSON with local zod enforcement — but we warn.
    for (const model of [body.modelEconomy, body.modelPremium]) {
      if (model && !(await modelSupportsStructuredOutputs(model))) {
        warnings.push({
          model,
          message: `Model "${model}" does not advertise structured-output support. It will run in prompt-only JSON mode (schema enforced locally, with repair retries).`,
        });
      }
    }

    const updated = await updateSettings(user.id, {
      ...(body.modelEconomy ? { modelEconomy: body.modelEconomy } : {}),
      ...(body.modelPremium ? { modelPremium: body.modelPremium } : {}),
      ...(body.costCapUsd !== undefined ? { costCapUsd: body.costCapUsd } : {}),
    });

    return NextResponse.json({
      modelEconomy: updated.modelEconomy,
      modelPremium: updated.modelPremium,
      costCapUsd: updated.costCapUsd,
      warnings,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
