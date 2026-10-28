import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cookieMock } from "../setup";
import { createTestUser, resetAuth } from "../support/auth";

// Contract tests for the auth endpoints (specs/008, contracts/auth-api.md).
// Route handlers run directly against the test database (project convention).
// Note: Set-Cookie header merging is performed by the Next.js runtime, so the
// cookie contract is asserted through the mocked cookies() store instead.
const BASE = "http://localhost:3000/api/auth";

function jsonReq(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetAuth();
});

describe("POST /api/auth/register", () => {
  it("creates the account, starts a session, returns 201 without leaking passwordHash", async () => {
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      jsonReq("/register", "POST", { email: "  Alice@Example.COM ", password: "password-123" }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe("alice@example.com"); // normalized: trim + lowercase
    expect(Object.keys(body.user)).toEqual(["id", "email"]); // no passwordHash, ever
    expect(JSON.stringify(body)).not.toContain("$argon2");

    const dbUser = await db.user.findUniqueOrThrow({ where: { email: "alice@example.com" } });
    expect(dbUser.passwordHash.startsWith("$argon2")).toBe(true);
    expect(await db.session.count({ where: { userId: dbUser.id } })).toBe(1);
    expect(cookieMock.sets.some((s) => s.name === "pf_session" && s.value)).toBe(true);
  });

  it("rejects a duplicate email case- and whitespace-insensitively (409 EMAIL_TAKEN)", async () => {
    const { POST } = await import("@/app/api/auth/register/route");
    const first = await POST(
      jsonReq("/register", "POST", { email: "dup@example.com", password: "password-123" }) as never,
    );
    expect(first.status).toBe(201);

    const second = await POST(
      jsonReq("/register", "POST", { email: "  DUP@Example.com ", password: "other-pass-456" }) as never,
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("EMAIL_TAKEN");
    expect(await db.user.count()).toBe(1); // no partial second account
  });

  it("rejects weak passwords and malformed emails (400 VALIDATION_ERROR)", async () => {
    const { POST } = await import("@/app/api/auth/register/route");
    const weak = await POST(
      jsonReq("/register", "POST", { email: "weak@example.com", password: "short" }) as never,
    );
    expect(weak.status).toBe(400);
    expect((await weak.json()).error.code).toBe("VALIDATION_ERROR");

    const badEmail = await POST(
      jsonReq("/register", "POST", { email: "not-an-email", password: "password-123" }) as never,
    );
    expect(badEmail.status).toBe(400);
    expect((await badEmail.json()).error.code).toBe("VALIDATION_ERROR");
    expect(await db.user.count()).toBe(0);
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials (200 + session)", async () => {
    await createTestUser("login-ok@example.com", "password-123");
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(
      jsonReq("/login", "POST", { email: " Login-OK@Example.com ", password: "password-123" }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe("login-ok@example.com");
    expect(await db.session.count()).toBe(1);
    expect(cookieMock.sets.some((s) => s.name === "pf_session")).toBe(true);
  });

  it("returns the IDENTICAL generic 401 for unknown email and wrong password", async () => {
    await createTestUser("known@example.com", "password-123");
    const { POST } = await import("@/app/api/auth/login/route");
    const unknown = await POST(
      jsonReq("/login", "POST", { email: "ghost@example.com", password: "password-123" }) as never,
    );
    const wrongPw = await POST(
      jsonReq("/login", "POST", { email: "known@example.com", password: "different-pass" }) as never,
    );
    expect(unknown.status).toBe(401);
    expect(wrongPw.status).toBe(401);
    const unknownBody = await unknown.json();
    const wrongPwBody = await wrongPw.json();
    expect(unknownBody).toEqual(wrongPwBody); // no enumeration
    expect(unknownBody.error.code).toBe("INVALID_CREDENTIALS");
    expect(await db.session.count()).toBe(0); // no session on failure
  });
});

describe("POST /api/auth/logout", () => {
  it("deletes the session row and clears the cookie (204)", async () => {
    const user = await createTestUser("logout@example.com");
    const { createTestSession } = await import("../support/auth");
    cookieMock.token = await createTestSession(user.id);
    expect(await db.session.count()).toBe(1);

    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST();
    expect(res.status).toBe(204);
    expect(await db.session.count()).toBe(0);
    expect(cookieMock.token).toBeUndefined();
    expect(cookieMock.deletes).toContain("pf_session");
  });

  it("returns 204 even when signed out (idempotent)", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST();
    expect(res.status).toBe(204);
  });
});

describe("GET /api/auth/session", () => {
  it("returns the current user when signed in (200)", async () => {
    const user = await createTestUser("session@example.com");
    const { createTestSession } = await import("../support/auth");
    cookieMock.token = await createTestSession(user.id);

    const { GET } = await import("@/app/api/auth/session/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: user.id, email: user.email } });
  });

  it("returns 401 UNAUTHENTICATED when signed out", async () => {
    const { GET } = await import("@/app/api/auth/session/route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });
});
