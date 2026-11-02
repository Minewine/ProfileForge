import { expect, test } from "@playwright/test";

// ci-validation: a failing e2e scenario must fail the CI run
test("ci-validation — intentionally fails", async () => {
  expect(true).toBe(false);
});
