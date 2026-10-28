import { beforeEach, describe, expect, it } from "vitest";
import { cookieMock } from "../setup";
import { createTestSession, createTestUser, resetAuth } from "../support/auth";
import { getCurrentUser, requireUser } from "@/lib/auth/guard";
import { ApiError } from "@/lib/api/errors";

beforeEach(async () => {
  await resetAuth();
});

describe("getCurrentUser (server components)", () => {
  it("returns the session user on a valid cookie", async () => {
    const user = await createTestUser("guard-ok@example.com");
    cookieMock.token = await createTestSession(user.id);
    await expect(getCurrentUser()).resolves.toEqual({ id: user.id, email: user.email });
  });

  it("returns null when signed out", async () => {
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns null on a garbage token", async () => {
    cookieMock.token = "garbage-token";
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

describe("requireUser (route handlers)", () => {
  it("returns the session user on a valid cookie", async () => {
    const user = await createTestUser("require-ok@example.com");
    cookieMock.token = await createTestSession(user.id);
    await expect(requireUser()).resolves.toEqual({ id: user.id, email: user.email });
  });

  it("throws 401 UNAUTHENTICATED when signed out", async () => {
    const err = await requireUser().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("UNAUTHENTICATED");
    expect((err as ApiError).message).not.toMatch(/user|email|session/i);
  });

  it("throws 401 UNAUTHENTICATED on an expired session", async () => {
    const user = await createTestUser("require-expired@example.com");
    cookieMock.token = await createTestSession(user.id, -1000);
    await expect(requireUser()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
