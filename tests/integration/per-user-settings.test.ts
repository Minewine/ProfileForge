import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetAuth, signIn } from "../support/auth";
import { resolveKey, saveKey, storedKeyHint } from "@/lib/settings/keyStore";
import { getSettings, updateSettings } from "@/lib/settings/store";
import { checkRunCap, recordUsage } from "@/lib/llm/usage";

/**
 * Per-user settings contract (specs/008 US3 / FR-007, FR-008): each account has
 * its own encrypted OpenRouter key, model preferences, and cost cap; usage is
 * attributed per user; no plaintext key ever leaves the server.
 */
let alice: { id: string; email: string };
let bob: { id: string; email: string };

beforeEach(async () => {
  await db.llmUsageLog.deleteMany({});
  await db.appSettings.deleteMany({});
  delete process.env.OPENROUTER_API_KEY;
  await resetAuth();
  alice = await signIn("alice-settings@example.com");
  bob = await signIn("bob-settings@example.com");
});

describe("per-user key storage", () => {
  it("saves the key under the owner's row only — encrypted, hint only", async () => {
    const hint = await saveKey(alice.id, "sk-or-v1-alices-secret-key");
    expect(hint).toBe("sk-or-v1…-key");

    const aliceRow = await db.appSettings.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(aliceRow.openRouterKeyEncrypted).toMatch(/^v1\./);
    expect(aliceRow.openRouterKeyEncrypted).not.toContain("alices-secret-key");
    expect(aliceRow.keyHint).toBe(hint);
    expect(await db.appSettings.count({ where: { userId: bob.id } })).toBe(0);
  });

  it("resolves the owner's key roundtrip; the other user has none", async () => {
    await saveKey(alice.id, "sk-or-v1-alices-secret-key");
    expect(await resolveKey(alice.id)).toEqual({ key: "sk-or-v1-alices-secret-key", source: "db" });
    expect(await resolveKey(bob.id)).toEqual({ key: null, source: null });
    expect(await storedKeyHint(bob.id)).toBeNull();
  });

  it("env var still overrides the stored key (documented resolution order)", async () => {
    await saveKey(alice.id, "sk-or-v1-alices-secret-key");
    process.env.OPENROUTER_API_KEY = "sk-or-v1-env-override-key";
    expect(await resolveKey(alice.id)).toEqual({ key: "sk-or-v1-env-override-key", source: "env" });
    delete process.env.OPENROUTER_API_KEY;
  });
});

describe("per-user model preferences and cost cap", () => {
  it("each user starts from defaults and updates independently", async () => {
    expect(await getSettings(alice.id)).toMatchObject({ costCapUsd: 0.5 });
    await updateSettings(alice.id, { costCapUsd: 2, modelPremium: "anthropic/claude-opus-4.6" });
    expect(await getSettings(alice.id)).toMatchObject({ costCapUsd: 2, modelPremium: "anthropic/claude-opus-4.6" });
    expect(await getSettings(bob.id)).toMatchObject({ costCapUsd: 0.5 });
    expect((await getSettings(bob.id)).modelPremium).not.toBe("anthropic/claude-opus-4.6");
  });
});

describe("per-user cost cap and usage attribution", () => {
  it("attributes usage rows to the calling user", async () => {
    await recordUsage(
      { task: "parse", model: "m", runId: "run-1", promptTokens: 1, completionTokens: 1, costUsd: 0.1, durationMs: 5 },
      alice.id,
    );
    const row = await db.llmUsageLog.findFirstOrThrow({ where: { runId: "run-1" } });
    expect(row.userId).toBe(alice.id);
  });

  it("enforces the cap per user — one user's spend never blocks another", async () => {
    await updateSettings(alice.id, { costCapUsd: 0.05 });
    await recordUsage(
      { task: "t", model: "m", runId: "run-alice", promptTokens: 1, completionTokens: 1, costUsd: 0.06, durationMs: 1 },
      alice.id,
    );
    await recordUsage(
      { task: "t", model: "m", runId: "run-bob", promptTokens: 1, completionTokens: 1, costUsd: 0.06, durationMs: 1 },
      bob.id,
    );

    await expect(checkRunCap("run-alice", alice.id)).rejects.toMatchObject({ code: "COST_CAP_REACHED" });
    await expect(checkRunCap("run-bob", bob.id)).resolves.toBeUndefined(); // bob's cap still 0.5
  });
});

describe("settings routes serve the signed-in user only", () => {
  it("a key saved by A is invisible in B's GET /api/settings", async () => {
    const putRoute = await import("@/app/api/settings/route");
    await putRoute.PUT(
      new Request("http://localhost:3000/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterKey: "sk-or-v1-alices-route-key" }),
      }) as never,
    );

    const { signOut, signIn } = await import("../support/auth");
    await signOut();
    await signIn("bob-settings@example.com"); // raw tokens aren't derivable — start a fresh session

    const res = await putRoute.GET();
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.keyConfigured).toBe(false);
    expect(dto.keyHint).toBeNull();
    expect(JSON.stringify(dto)).not.toContain("alices-route-key");
  });
});
