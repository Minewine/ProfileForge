import { describe, expect, it } from "vitest";

// ci-validation: a failing unit test must fail the CI run
describe("ci-validation", () => {
  it("intentionally fails", () => {
    expect(1).toBe(2);
  });
});
