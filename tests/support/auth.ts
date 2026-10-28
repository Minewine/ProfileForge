import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { cookieMock } from "../setup";

export type SessionUser = { id: string; email: string };

/** Creates a User row with an Argon2id-hashed password (normalized email).
 * Idempotent per email so suites can re-sign-in the same identities. */
export async function createTestUser(email: string, password = "password-123") {
  const normalized = email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email: normalized } });
  if (existing) return existing;
  try {
    return await db.user.create({
      data: { email: normalized, passwordHash: await hashPassword(password) },
    });
  } catch {
    return db.user.findUniqueOrThrow({ where: { email: normalized } });
  }
}

/** Creates a Session row for the user and returns the RAW token (as a browser would hold it). */
export async function createTestSession(userId: string, ttlMs = 30 * 24 * 60 * 60 * 1000): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

/** Signs a test in: user + session rows exist and the cookie mock carries the token. */
export async function signIn(email: string, password = "password-123") {
  const user = await createTestUser(email, password);
  const token = await createTestSession(user.id);
  cookieMock.token = token;
  return { id: user.id, email: user.email };
}

export function signOut() {
  cookieMock.token = undefined;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Wipes all auth data and resets the cookie mock. Call in beforeEach. */
export async function resetAuth() {
  await db.session.deleteMany({});
  await db.user.deleteMany({});
  cookieMock.token = undefined;
  cookieMock.sets.length = 0;
  cookieMock.deletes.length = 0;
}
