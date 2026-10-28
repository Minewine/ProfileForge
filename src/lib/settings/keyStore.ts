import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { decryptSecret, encryptSecret } from "@/lib/settings/crypto";

export type KeyResolution = { key: string; source: "env" | "db" } | { key: null; source: null };

/** Resolution order (R6): OPENROUTER_API_KEY env → the user's encrypted settings row (specs/008 FR-007). */
export async function resolveKey(userId: string): Promise<KeyResolution> {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };

  const row = await db.appSettings.findUnique({ where: { userId } });
  if (row?.openRouterKeyEncrypted) {
    try {
      return { key: decryptSecret(row.openRouterKeyEncrypted), source: "db" };
    } catch {
      // Undecryptable payload (rotated APP_SECRET?) — treat as no key, UI re-entry fixes it.
      return { key: null, source: null };
    }
  }
  return { key: null, source: null };
}

/** Masked hint, e.g. sk-or-v1…f4a2 (FR-006/FR-007 — never the full key). */
export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export async function saveKey(userId: string, key: string): Promise<string> {
  const encrypted = encryptSecret(key);
  await db.appSettings.upsert({
    where: { userId },
    create: { userId, openRouterKeyEncrypted: encrypted, keyHint: maskKey(key) },
    update: { openRouterKeyEncrypted: encrypted, keyHint: maskKey(key) },
  });
  return maskKey(key);
}

export async function storedKeyHint(userId: string): Promise<string | null> {
  const row = await db.appSettings.findUnique({ where: { userId } });
  return row?.keyHint ?? null;
}

/** Validates a key against OpenRouter without spending tokens. */
export async function validateKeyAgainstOpenRouter(
  key: string,
): Promise<{ valid: true; label?: string } | { valid: false; reason: "invalid" | "quota" | "unavailable" }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) return { valid: false, reason: "invalid" };
    if (res.status === 402) return { valid: false, reason: "quota" };
    if (!res.ok) return { valid: false, reason: "unavailable" };
    const body = (await res.json()) as { data?: { label?: string } };
    return { valid: true, label: body.data?.label };
  } catch {
    return { valid: false, reason: "unavailable" };
  }
}

export async function requireKey(userId: string): Promise<string> {
  const resolved = await resolveKey(userId);
  if (!resolved.key) {
    throw new ApiError(
      "LLM_KEY_INVALID",
      "No OpenRouter API key configured. Add one in Settings or set OPENROUTER_API_KEY.",
    );
  }
  return resolved.key;
}
