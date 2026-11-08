import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callLLM, registerTask, resetTaskRegistry } from "@/lib/llm/router";
import { db } from "@/lib/db";
import { createTestUser } from "../support/auth";
import { modelSupportsStructuredOutputs } from "@/lib/settings/models";

vi.mock("@/lib/settings/models", () => ({
  modelSupportsStructuredOutputs: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue([]),
}));

const OK_USAGE = { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 };

function okResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(async () => {
  resetTaskRegistry();
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test-key";
  // other test files may leave a stored key or usage rows behind — clean slate
  await db.llmUsageLog.deleteMany({});
  await db.appSettings.deleteMany({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
});

const testTask = {
  name: "testTask" as const,
  tier: "economy" as const,
  outputSchema: z.object({ answer: z.string() }),
  buildPrompt: () => [{ role: "user" as const, content: "answer yes" }],
};

describe("llm router", () => {
  it("passes schema-valid responses through and records usage", async () => {
    registerTask(testTask);
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: JSON.stringify({ answer: "yes" }) } }],
        usage: OK_USAGE,
        model: "test/model",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callLLM({ userId: "u-test", task: "testTask", payload: {} });
    expect(result.data).toEqual({ answer: "yes" });
    expect(result.usage.costUsd).toBe(0.001);
    expect(fetchMock).toHaveBeenCalledOnce();

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider.require_parameters).toBe(true);
  });

  it("repairs schema-invalid output (max 2 retries) then fails with LLM_SCHEMA_REPAIR_FAILED", async () => {
    registerTask(testTask);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: JSON.stringify({ wrong: 1 }) } }], usage: OK_USAGE }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: JSON.stringify({ wrong: 2 }) } }], usage: OK_USAGE }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: JSON.stringify({ wrong: 3 }) } }], usage: OK_USAGE }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(callLLM({ userId: "u-test", task: "testTask", payload: {} })).rejects.toMatchObject({
      code: "LLM_SCHEMA_REPAIR_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 repairs
  });

  it("maps OpenRouter error statuses to actionable codes", async () => {
    registerTask(testTask);
    for (const [status, code] of [
      [401, "LLM_KEY_INVALID"],
      [402, "LLM_QUOTA"],
      [429, "LLM_RATE_LIMITED"],
      [500, "LLM_UNAVAILABLE"],
    ] as const) {
      resetTaskRegistry();
      registerTask(testTask);
      const fetchMock = vi.fn().mockResolvedValue(okResponse({ error: { message: "x" } }, status));
      vi.stubGlobal("fetch", fetchMock);
      await expect(callLLM({ userId: "u-test", task: "testTask", payload: {} })).rejects.toMatchObject({ code });
    }
  });

  it("degrades to prompt-only JSON for models without structured-output support", async () => {
    registerTask(testTask);
    vi.mocked(modelSupportsStructuredOutputs).mockResolvedValueOnce(false);
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: JSON.stringify({ answer: "yes" }) } }],
        usage: OK_USAGE,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callLLM({ userId: "u-test", task: "testTask", payload: {} });
    expect(result.data).toEqual({ answer: "yes" });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toBeUndefined();
    // the schema must ride in the prompt instead
    const systemMessages = body.messages.filter((m: { role: string }) => m.role === "system");
    expect(systemMessages.some((m: { content: string }) => m.content.includes("JSON Schema"))).toBe(
      true,
    );
  });

  it("throws TASK_NOT_IMPLEMENTED for unregistered tasks", async () => {
    await expect(callLLM({ userId: "u-test", task: "parseCV", payload: {} })).rejects.toMatchObject({
      code: "TASK_NOT_IMPLEMENTED",
    });
  });

  it("throws LLM_KEY_INVALID before any network call when no key is configured", async () => {
    registerTask(testTask);
    delete process.env.OPENROUTER_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(callLLM({ userId: "u-test", task: "testTask", payload: {} })).rejects.toMatchObject({
      code: "LLM_KEY_INVALID",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the per-run cost cap before making calls", async () => {
    registerTask(testTask);
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test-key";
    // cap is derived from LlmUsageLog rows (default cap 0.5), so seed real spend
    // against a real user — the table enforces its owner FK
    const capUser = await createTestUser("cap-router@example.com");
    await db.llmUsageLog.create({
      data: {
        userId: capUser.id,
        task: "testTask",
        model: "test/model",
        runId: "run-cap",
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0.50,
        durationMs: 1,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      callLLM({ userId: capUser.id, task: "testTask", payload: {}, runId: "run-cap" }),
    ).rejects.toMatchObject({ code: "COST_CAP_REACHED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("run cost accumulates from usage rows, surviving a fresh process (no in-memory state)", async () => {
    const { checkRunCap, recordUsage } = await import("@/lib/llm/usage");
    const accUser = await createTestUser("acc-router@example.com");
    await recordUsage(
      { task: "t", model: "m", runId: "run-acc", promptTokens: 1, completionTokens: 1, costUsd: 0.3, durationMs: 1 },
      accUser.id,
    );
    // a restart would drop any module-level accumulation; the second write models
    // the same run continuing after it
    await recordUsage(
      { task: "t", model: "m", runId: "run-acc", promptTokens: 1, completionTokens: 1, costUsd: 0.3, durationMs: 1 },
      accUser.id,
    );
    await expect(checkRunCap("run-acc", accUser.id)).rejects.toMatchObject({ code: "COST_CAP_REACHED" });
  });

  it("records usage for every attempt, including failed repair attempts (P1 cap ledger)", async () => {
    registerTask(testTask);
    const spendUser = await createTestUser("repair-usage@example.com");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: JSON.stringify({ wrong: 1 }) } }], usage: OK_USAGE }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: JSON.stringify({ wrong: 2 }) } }], usage: OK_USAGE }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: JSON.stringify({ answer: "yes" }) } }], usage: OK_USAGE }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callLLM({ userId: spendUser.id, task: "testTask", payload: {}, runId: "run-repair" });
    expect(result.data).toEqual({ answer: "yes" });
    // three real provider responses = three rows in the ledger; the success-path
    // recording alone dropped the two failed repair attempts from the cap
    const rows = await db.llmUsageLog.findMany({ where: { runId: "run-repair" } });
    expect(rows).toHaveLength(3);
  });

  it("warns loudly when the provider omits the cost field but still records the spend (P1)", async () => {
    registerTask(testTask);
    const nocostUser = await createTestUser("nocost-usage@example.com");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: JSON.stringify({ answer: "yes" }) } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 }, // no cost field
        model: "test/model",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callLLM({ userId: nocostUser.id, task: "testTask", payload: {}, runId: "run-nocost" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no cost field"));
    const rows = await db.llmUsageLog.findMany({ where: { runId: "run-nocost" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBe(0); // recorded at 0 — with the warning making the gap visible
    warnSpy.mockRestore();
  });
});
