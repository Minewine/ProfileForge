import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapOpenRouterStatus } from "@/lib/llm/errors";

// Feature 006 US1 (contracts/error-messages.md): server-side failure text is
// the single source of truth — every message names the cause and points at one
// concrete next action (Settings / top-up / retry / model switch). The source
// modules that cannot be imported hermetically (they pull the DB / fetch) are
// contract-checked by reading their source — the same honesty trick the
// codebase uses for fixture drift.

describe("mapOpenRouterStatus messages (actionable per contract)", () => {
  it("401/403 → LLM_KEY_INVALID pointing at Settings", () => {
    for (const status of [401, 403]) {
      const err = mapOpenRouterStatus(status);
      expect(err.code).toBe("LLM_KEY_INVALID");
      expect(err.message).toMatch(/Settings/);
    }
  });

  it("402 → LLM_QUOTA naming credit exhaustion and the Settings/model remedy", () => {
    const err = mapOpenRouterStatus(402);
    expect(err.code).toBe("LLM_QUOTA");
    expect(err.message).toMatch(/credit/i);
    expect(err.message).toMatch(/Settings|free model/i); // the smoke-test gap: bare "top up" only
  });

  it("429 → LLM_RATE_LIMITED naming rate limiting and retry", () => {
    const err = mapOpenRouterStatus(429);
    expect(err.code).toBe("LLM_RATE_LIMITED");
    expect(err.message).toMatch(/rate/i);
    expect(err.message).toMatch(/retry/i);
  });

  it("unmapped statuses → LLM_UNAVAILABLE with retry + work-preservation note", () => {
    for (const status of [404, 500, 503]) {
      const err = mapOpenRouterStatus(status);
      expect(err.code).toBe("LLM_UNAVAILABLE");
      expect(err.message).toMatch(/retry/i);
      expect(err.message).toMatch(/preserved/i);
    }
  });
});

describe("server message sources (contract-checked by source read)", () => {
  const source = (path: string): string => readFileSync(path, "utf8");

  it("requireKey's LLM_KEY_INVALID message points at Settings", () => {
    const keyStore = source("src/lib/settings/keyStore.ts");
    const thrown = keyStore.match(/"No OpenRouter API key[^"]*"/)?.[0] ?? "";
    expect(thrown).toMatch(/Settings/);
  });

  it("the LLM execution path keeps the Settings/model-switch action on repair failure", () => {
    // spec 009 US5 moved the execution body to the transport module; the
    // user-facing contract text must survive the move.
    const transport = source("src/lib/llm/transport.ts");
    const thrown = transport.match(/"The model repeatedly[^"]*"/)?.[0] ?? "";
    expect(thrown).toMatch(/Settings/);
    expect(thrown).toMatch(/switch/i);
  });

  it("the LLM execution path logs provider failure detail before mapping (FR-002 diagnostic retention)", () => {
    const transport = source("src/lib/llm/transport.ts");
    // the redacted console.warn carrying status + body snippet in the failure path
    expect(transport).toMatch(/console\.warn\(redact\(/);
  });

  it("the overlap conflict string directs to the Profile editor and never says 'verify' (FR-003)", () => {
    const literals = source("src/lib/profile/repository.ts").match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    // message literals only — skip bare machine codes like "DATE_RANGE_OVERLAP"
    const overlapStrings = literals.filter((l) => /overlap/i.test(l) && l.includes(" "));
    expect(overlapStrings.length).toBeGreaterThanOrEqual(1); // the editor warning (generation no longer blocks on overlap)
    for (const text of overlapStrings) {
      expect(text).not.toMatch(/verify/i);
      expect(text).toMatch(/Profile editor/i);
      expect(text).toMatch(/Start\/End dates/i);
    }
  });
});
