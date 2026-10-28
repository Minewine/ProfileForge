import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callLLM, registerTask, resetTaskRegistry } from "@/lib/llm/router";
import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
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
  // other test files may leave a stored key behind — the env var must win cleanly
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
    const { setRunCostForTests } = await import("@/lib/llm/usage");
    setRunCostForTests("run-cap", 0.50);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        callLLM({ userId: "u-test", task: "testTask", payload: {}, runId: "run-cap" }),
      ).rejects.toBeInstanceOf(ApiError);
    } finally {
      setRunCostForTests("run-cap", 0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
