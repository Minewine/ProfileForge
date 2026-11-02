import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { getSettings } from "@/lib/settings/store";

export type UsageRecord = {
  task: string;
  model: string;
  runId: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
};

/**
 * FR-008: hard stop when the run's accumulated cost reaches the user's configured cap.
 * Accumulation is derived from the LlmUsageLog rows written by recordUsage, so it
 * survives a server restart (a module-level Map used to reset it mid-run) and would
 * hold across multiple app instances.
 */
export async function checkRunCap(runId: string, userId: string) {
  const settings = await getSettings(userId);
  const row = await db.llmUsageLog.aggregate({
    where: { runId },
    _sum: { costUsd: true },
  });
  const accumulated = row._sum.costUsd ?? 0;
  if (accumulated >= settings.costCapUsd) {
    throw new ApiError(
      "COST_CAP_REACHED",
      `This run has reached the $${settings.costCapUsd.toFixed(2)} cost cap ` +
        `($${accumulated.toFixed(4)} spent). Raise the cap in Settings to continue.`,
      { accumulated, cap: settings.costCapUsd },
    );
  }
}

export async function recordUsage(u: UsageRecord, userId: string) {
  try {
    await db.llmUsageLog.create({
      data: {
        userId,
        task: u.task,
        model: u.model,
        runId: u.runId,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        costUsd: u.costUsd,
        durationMs: u.durationMs,
      },
    });
  } catch {
    // Usage logging must never break an AI call.
  }
}
debugger;
