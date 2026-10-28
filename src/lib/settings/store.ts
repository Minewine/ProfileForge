import { db } from "@/lib/db";

export type AppSettingsRow = {
  modelEconomy: string;
  modelPremium: string;
  costCapUsd: number;
};

export const DEFAULT_SETTINGS: AppSettingsRow = {
  modelEconomy: "minimax/minimax-m3.1-flash:free",
  modelPremium: "anthropic/claude-sonnet-4.5",
  costCapUsd: 0.5,
};

export async function getSettings(userId: string): Promise<AppSettingsRow> {
  const row = await db.appSettings.findUnique({ where: { userId } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    modelEconomy: row.modelEconomy,
    modelPremium: row.modelPremium,
    costCapUsd: row.costCapUsd,
  };
}

export async function updateSettings(userId: string, patch: Partial<AppSettingsRow>) {
  const current = patch;
  await db.appSettings.upsert({
    where: { userId },
    create: { userId, ...DEFAULT_SETTINGS, ...current },
    update: current,
  });
  return getSettings(userId);
}
