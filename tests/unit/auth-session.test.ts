import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cookieMock } from "../setup";
import { createTestSession, createTestUser, resetAuth, sha256 } from "../support/auth";
import { SESSION_COOKIE, createSession, destroySession, getSessionUser } from "@/lib/auth/session";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetAuth();
});

describe("createSession", () => {
  it("stores only the SHA-256 hash — the raw token never reaches the database", async () => {
    const user = await createTestUser("hash-only@example.com");
    await createSession(user.id);

    const rows = await db.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const raw = cookieMock.token;
    expect(raw).toBeTruthy();
    expect(raw).not.toBe(rows[0].tokenHash);
    // no row anywhere contains the raw cookie value
    expect(JSON.stringify(rows)).not.toContain(raw as string);
  });

  it("sets the pf_session cookie with hardening attributes", async () => {
    const user = await createTestUser("cookie-attrs@example.com");
    await createSession(user.id);

    const set = cookieMock.sets.at(-1);
    expect(set?.name).toBe(SESSION_COOKIE);
    const options = (set?.options ?? {}) as Record<string, unknown>;
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    // plain-http test env must NOT set Secure or the cookie would be dropped
    expect(options.secure).toBe(false);
    expect(Number(options.maxAge)).toBeGreaterThan(29 * 24 * 60 * 60); // seconds
  });

  it("expires the session after 30 days", async () => {
    const user = await createTestUser("expiry@example.com");
    await createSession(user.id);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    const remaining = row.expiresAt.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(29 * DAY_MS);
    expect(remaining).toBeLessThanOrEqual(30 * DAY_MS);
  });
});

describe("getSessionUser", () => {
  it("resolves the signed-in user from the cookie", async () => {
    const user = await createTestUser("resolve@example.com");
    cookieMock.token = await createTestSession(user.id);
    await expect(getSessionUser()).resolves.toEqual({ id: user.id, email: user.email });
  });

  it("returns null without a cookie", async () => {
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("returns null for an unknown token", async () => {
    cookieMock.token = "no-such-session-token";
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("rejects an expired session", async () => {
    const user = await createTestUser("expired@example.com");
    cookieMock.token = await createTestSession(user.id, -1000);
    await expect(getSessionUser()).resolves.toBeNull();
    // and the stale row is not silently resurrected
    expect(await db.session.findFirst({ where: { userId: user.id } })).not.toBeNull();
  });

  it("never returns the passwordHash", async () => {
    const user = await createTestUser("no-leak@example.com");
    cookieMock.token = await createTestSession(user.id);
    expect(Object.keys((await getSessionUser()) as object)).toEqual(["id", "email"]);
  });
});

describe("sliding renewal", () => {
  it("extends a session nearing expiry and re-issues the cookie", async () => {
    const user = await createTestUser("renew@example.com");
    cookieMock.token = await createTestSession(user.id, 10 * DAY_MS);
    const before = await db.session.findFirstOrThrow({ where: { userId: user.id } });

    await getSessionUser();

    const after = await db.session.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY_MS);
    const reissue = cookieMock.sets.find((s) => s.name === SESSION_COOKIE);
    expect(reissue).toBeTruthy();
    expect(reissue?.value).toBe(cookieMock.token);
  });

  it("leaves a fresh session alone (no extension, no cookie re-issue)", async () => {
    const user = await createTestUser("fresh@example.com");
    cookieMock.token = await createTestSession(user.id, 30 * DAY_MS);
    const before = await db.session.findFirstOrThrow({ where: { userId: user.id } });

    await getSessionUser();

    const after = await db.session.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(cookieMock.sets).toHaveLength(0);
  });
});

describe("destroySession", () => {
  it("deletes the session row and clears the cookie", async () => {
    const user = await createTestUser("destroy@example.com");
    cookieMock.token = await createTestSession(user.id);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);

    await destroySession();

    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(cookieMock.token).toBeUndefined();
    expect(cookieMock.deletes).toContain(SESSION_COOKIE);
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("is a no-op without a cookie", async () => {
    await expect(destroySession()).resolves.toBeUndefined();
    expect(await db.session.count()).toBe(0);
  });

  it("is a no-op for an unknown token", async () => {
    cookieMock.token = sha256("irrelevant");
    cookieMock.token = "unknown-raw-token";
    await expect(destroySession()).resolves.toBeUndefined();
  });
});
