import { beforeEach, describe, expect, it, vi } from "vitest";
import { callLLM, resetTaskRegistry } from "@/lib/llm/router";
import { ensureExtractRequirementsRegistered } from "@/lib/llm/tasks/extractrequirements";

vi.mock("@/lib/settings/models", () => ({
  modelSupportsStructuredOutputs: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue([]),
}));

const okUsage = { promptTokens: 10, completionTokens: 5, costUsd: 0.001 };
function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  resetTaskRegistry();
  ensureExtractRequirementsRegistered();
  vi.unstubAllGlobals();
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
});

describe("extractRequirements task", () => {
  it("registers under the canonical name on the economy tier and sends the binding zero-injection prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                requirements: [
                  { text: "Kubernetes", category: "tool", importance: "must", isHardConstraint: true },
                  { text: "Kafka", category: "tool", importance: "nice", isHardConstraint: false },
                ],
                role: "Senior Backend Engineer — Payments Platform",
                company: null,
              }),
            },
          },
        ],
        usage: okUsage,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callLLM({ userId: "u-test",
      task: "extractRequirements",
      payload: { text: "a".repeat(300), language: "en" },
    });
    expect((result.data as { requirements: unknown[] }).requirements).toHaveLength(2);
    // role/company ride along for the draft prompts (null = absent in the JD)
    const data = result.data as { role?: string | null; company?: string | null };
    expect(data.role).toBe("Senior Backend Engineer — Payments Platform");
    expect(data.company).toBeNull();

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBeDefined();
    const prompt = body.messages.map((m: { content: string }) => m.content).join("\n");
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("exigé");
    expect(prompt).toContain("CONCISE phrase");
  });

  it("validates its input schema (short text rejected)", async () => {
    await expect(
      callLLM({ userId: "u-test", task: "extractRequirements", payload: { text: "short", language: "en" } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
