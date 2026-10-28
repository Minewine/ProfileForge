import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetAuth, signIn } from "../support/auth";

const PUT_URL = "http://localhost:3000/api/settings";

let settingsUser: { id: string };

function putRequest(key: string): Request {
  return new Request(PUT_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ openRouterKey: key }),
  });
}

function validatorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "x" } }), { status });
}

beforeEach(async () => {
  await resetAuth();
  settingsUser = await signIn("settings-key@example.com");
  delete process.env.OPENROUTER_API_KEY;
  await db.appSettings.deleteMany({});
  vi.unstubAllGlobals();
});

describe("PUT /api/settings key saving", () => {
  it("rejects a definitively invalid key (401) and does not save it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(validatorResponse(401)));
    const { PUT } = await import("@/app/api/settings/route");
    const res = await PUT(putRequest("sk-or-v1-definitely-a-wrong-key") as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("LLM_KEY_INVALID");
    const row = await db.appSettings.findUnique({ where: { userId: settingsUser.id } });
    expect(row?.openRouterKeyEncrypted ?? null).toBeNull(); // no row or no key — either way: not saved
  });

  it("saves a zero-credit key (402) with a credit warning — free models still work", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(validatorResponse(402)));
    const { PUT } = await import("@/app/api/settings/route");
    const res = await PUT(putRequest("sk-or-v1-real-but-broke-key-123") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keySaved).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].message).toContain("no remaining credit");
    const row = await db.appSettings.findUnique({ where: { userId: settingsUser.id } });
    expect(row?.openRouterKeyEncrypted).not.toBeNull();
    expect(row?.keyHint).toBe(body.keyHint);
  });

  it("saves the key even when the validator is unreachable, with a warning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { PUT } = await import("@/app/api/settings/route");
    const res = await PUT(putRequest("sk-or-v1-real-key-unverifiable-9") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyValidation).toMatchObject({ valid: false, reason: "unavailable" });
    expect((await db.appSettings.findUnique({ where: { userId: settingsUser.id } }))?.keyHint).toBeTruthy();
  });

  it("saves a fully valid key with no warnings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { label: "my-key" } }), { status: 200 }),
      ),
    );
    const { PUT } = await import("@/app/api/settings/route");
    const res = await PUT(putRequest("sk-or-v1-totally-valid-key-7777") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toHaveLength(0);
    expect(body.keyValidation).toMatchObject({ valid: true, label: "my-key" });
  });
});
