import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { maskKey, resolveKey, saveKey, storedKeyHint } from "@/lib/settings/keyStore";
import { decryptSecret, encryptSecret } from "@/lib/settings/crypto";
import { resetAuth, signIn } from "../support/auth";

let userId: string;

beforeEach(async () => {
  delete process.env.OPENROUTER_API_KEY;
  await db.appSettings.deleteMany({});
  await resetAuth();
  userId = (await signIn("keystore@example.com")).id;
});

describe("crypto roundtrip", () => {
  it("encrypts and decrypts secrets with AES-256-GCM", () => {
    const secret = "sk-or-v1-abcdef1234567890";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(decryptSecret(encrypted)).toBe(secret);
  });
});

describe("key store", () => {
  it("masks keys — never returns them in full", () => {
    expect(maskKey("sk-or-v1-abcdef1234567890")).toBe("sk-or-v1…7890");
  });

  it("prefers the env var over the stored key and resolves stored keys roundtrip", async () => {
    await saveKey(userId, "sk-or-v1-stored-key-1234");
    process.env.OPENROUTER_API_KEY = "sk-or-v1-env-key-5678";
    expect(await resolveKey(userId)).toEqual({ key: "sk-or-v1-env-key-5678", source: "env" });

    delete process.env.OPENROUTER_API_KEY;
    const resolved = await resolveKey(userId);
    expect(resolved.source).toBe("db");
    expect(resolved.key).toBe("sk-or-v1-stored-key-1234");
    expect(await storedKeyHint(userId)).toBe("sk-or-v1…1234");
  });
});
