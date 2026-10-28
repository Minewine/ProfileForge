import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";

export const SESSION_COOKIE = "pf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000; // slide forward when <15 days remain

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function isHttpsRequest(): Promise<boolean> {
  const h = await headers();
  return (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

/** Creates a DB session and sets the cookie. Only the token's SHA-256 is stored. */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(await isHttpsRequest()));
}

/**
 * Resolves the signed-in user from the session cookie, or null. Extends the DB
 * session when it is nearing expiry; the cookie re-issue is skipped silently in
 * read-only contexts (server component render) where cookies() cannot set — the
 * DB-side sliding renewal still applied.
 */
export async function getSessionUser(): Promise<{ id: string; email: string } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, expiresAt: true, user: { select: { id: true, email: true } } },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;

  if (session.expiresAt.getTime() - Date.now() < RENEW_THRESHOLD_MS) {
    await db.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    try {
      (await cookies()).set(SESSION_COOKIE, token, cookieOptions(await isHttpsRequest()));
    } catch {
      // read-only cookie context (RSC render) — renewal persists in the DB only
    }
  }
  return session.user;
}

/** Deletes the current session row and clears the cookie; safe to call unauthenticated. */
export async function destroySession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  try {
    (await cookies()).delete(SESSION_COOKIE);
  } catch {
    // read-only cookie context — nothing to clear server-side
  }
}
