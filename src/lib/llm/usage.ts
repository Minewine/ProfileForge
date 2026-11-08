import { db } from "@/lib/db";
import { ApiError, redact } from "@/lib/api/errors";
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
 *
 * Accepted imprecision (P1 review): the check is read-then-log, so parallel
 * calls within one run can each pass the check before any of them records —
 * the cap can overshoot by up to (n−1) in-flight call costs. Reserving budget
 * atomically per call was rejected as overkill for a local single-process app;
 * per-attempt recording below keeps the ledger otherwise faithful.
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
  } catch (err) {
    // Usage logging must never break an AI call — but never silently: the cap
    // derives from these rows, so a persistently failing insert would disable
    // the hard stop for the run (P1 review).
    console.warn(redact(`usage log insert failed — cost cap may under-count: ${String(err)}`));
  }
}
