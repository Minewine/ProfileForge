import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("hashPassword / verifyPassword (Argon2id)", () => {
  it("roundtrips a password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "incorrect horse")).toBe(false);
  });

  it("never exposes the plaintext in the hash", async () => {
    const secret = "sk-or-v1-super-secret-password";
    const hash = await hashPassword(secret);
    expect(hash).not.toContain(secret);
  });

  it("salts — identical passwords produce different hashes", async () => {
    const a = await hashPassword("same-password-123");
    const b = await hashPassword("same-password-123");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same-password-123")).toBe(true);
    expect(await verifyPassword(b, "same-password-123")).toBe(true);
  });

  it("treats a malformed hash as a failed verification, not a crash", async () => {
    expect(await verifyPassword("not-a-real-argon2-hash", "whatever")).toBe(false);
  });
});
