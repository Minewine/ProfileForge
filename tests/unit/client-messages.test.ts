import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeError,
  FLAG_EXPLANATIONS,
  LLM_ERROR_GUIDANCE,
} from "@/lib/client-messages";

// Feature 006 foundational guard (contracts/error-messages.md): the shared
// client-safe message maps must cover every code the server emits — a new code
// without guidance/explanation fails here before it can ship unexplained.

const LLM_CODES = [
  "LLM_KEY_INVALID",
  "LLM_QUOTA",
  "LLM_RATE_LIMITED",
  "LLM_UNAVAILABLE",
  "LLM_SCHEMA_REPAIR_FAILED",
] as const;

/** The complete flag-code inventory emitted by the draft merge
 *  (src/lib/generation/draft.ts) since the Fact Guard removal — warnings only.
 *  Profile-claims codes (INCONSISTENT_STATE, MISSING_LOCATOR,
 *  CONTAINMENT_UNRESOLVED) are not generation flags — deliberately absent. */
const FLAG_CODES = ["VERBATIM_FALLBACK", "UNCERTAIN_TRANSLATION"] as const;

describe("LLM_ERROR_GUIDANCE", () => {
  it("covers exactly the LLM error codes with short non-empty actions", () => {
    expect(Object.keys(LLM_ERROR_GUIDANCE).sort()).toEqual([...LLM_CODES].sort());
    for (const action of Object.values(LLM_ERROR_GUIDANCE)) {
      expect(action.trim().length).toBeGreaterThan(0);
      expect(action.length).toBeLessThanOrEqual(90);
    }
  });

  it("points each code at its contract action (Settings / top-up / retry / model switch)", () => {
    expect(LLM_ERROR_GUIDANCE.LLM_KEY_INVALID).toMatch(/Settings/i);
    expect(LLM_ERROR_GUIDANCE.LLM_QUOTA).toMatch(/credit|top up|Settings/i);
    expect(LLM_ERROR_GUIDANCE.LLM_RATE_LIMITED).toMatch(/retry/i);
    expect(LLM_ERROR_GUIDANCE.LLM_UNAVAILABLE).toMatch(/retry/i);
    expect(LLM_ERROR_GUIDANCE.LLM_SCHEMA_REPAIR_FAILED).toMatch(/models|Settings|retry/i);
  });
});

describe("FLAG_EXPLANATIONS", () => {
  it("covers exactly the emitted flag codes (completeness guard)", () => {
    expect(Object.keys(FLAG_EXPLANATIONS).sort()).toEqual([...FLAG_CODES].sort());
  });

  it("every explanation is a single sentence naming the resolution action", () => {
    for (const [code, text] of Object.entries(FLAG_EXPLANATIONS)) {
      expect(text.trim().length, code).toBeGreaterThan(10);
      expect((text.match(/\./g) ?? []).length, code).toBeLessThanOrEqual(2); // one sentence (allow one abbreviation dot)
      expect(text).toMatch(/[—-] /); // dash-introduced action, per the contract strings
    }
    expect(FLAG_EXPLANATIONS.VERBATIM_FALLBACK).toMatch(/original/i);
    expect(FLAG_EXPLANATIONS.UNCERTAIN_TRANSLATION).toMatch(/double-check/i);
  });
});

describe("describeError", () => {
  it("returns the server message plus the code's action pointer", () => {
    expect(describeError("LLM_QUOTA", "OpenRouter credit is exhausted.")).toMatchObject({
      code: "LLM_QUOTA",
      message: "OpenRouter credit is exhausted.",
      action: LLM_ERROR_GUIDANCE.LLM_QUOTA,
    });
  });

  it("splits a job statusError on the first ': ' for code lookup", () => {
    const described = describeError(
      "PAGE_BUDGET_CONFLICT: The must-include content alone needs 3 pages but the budget is 1. Raise the page budget or trim the must-include items (restored omissions).",
    );
    expect(described.code).toBe("PAGE_BUDGET_CONFLICT");
    expect(described.message).toContain("must-include content alone needs 3 pages");
    expect(described.action).toMatch(/budget/i);
  });

  it("unknown codes pass through with null action — never invented guidance", () => {
    expect(describeError("SOME_NEW_CODE", "Something odd.")).toEqual({
      code: "SOME_NEW_CODE",
      message: "Something odd.",
      action: null,
    });
    expect(describeError("EXPORT_GATE_FAILED: The rendered PDF failed.")).toMatchObject({
      code: "EXPORT_GATE_FAILED",
      message: "The rendered PDF failed.",
      action: expect.stringMatching(/regenerate/i),
    });
  });

  it("handles a statusError with no code separator as a bare message", () => {
    expect(describeError("plain failure text")).toEqual({
      code: null,
      message: "plain failure text",
      action: null,
    });
  });
});

describe("module purity (client-component safety)", () => {
  it("src/lib/client-messages.ts contains no import statements", () => {
    const source = readFileSync("src/lib/client-messages.ts", "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/require\(/);
  });
});
