import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { apiGet } from "./support/env";

// specs/008: runs as the seed account (the designated owner) via its session cookie.
test.use({ storageState: "tests/e2e/.auth-state.json" });

const seedState: { legacy: { analysisId: string } } = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests", "e2e", ".seed-state.json"), "utf8"),
);

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e";

function claimLegacyData() {
  // Runs against the e2e database ONLY (explicit URL — never the developer's main DB).
  execSync(`npx tsx scripts/assign-owner.ts --email e2e@example.com --password password-123`, {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });
}

/**
 * US4 legacy-data claim (specs/008, quickstart Scenario 5 / SC-005). Serial:
 * the claim mutates state. The storageState session (seed account) is the
 * designated owner.
 */
test.describe.serial("US4 — existing single-user data is claimed by its owner", () => {
  test("quarantined legacy data is invisible to every account before the claim", async ({ request }) => {
    const res = await request.get(`/api/jobs/${seedState.legacy.analysisId}`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  test("assign-owner claims it for the designated owner", async ({ request }) => {
    claimLegacyData();

    const res = await request.get(`/api/jobs/${seedState.legacy.analysisId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).analysis.jdText).toContain("LEGACY-CLAIM-PROBE");
  });

  test("a different account still sees nothing", async ({ browser }) => {
    const ctx = await (browser as Browser).newContext({ storageState: { cookies: [], origins: [] } }); // signed out
    const page = await ctx.newPage();
    await page.goto("/register");
    await page.getByLabel("Email").fill("bob-claim@example.com");
    await page.getByLabel("Password").fill("password-123");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/profile$/);

    const res = await page.context().request.get(`/api/jobs/${seedState.legacy.analysisId}`);
    expect(res.status()).toBe(404);
    await ctx.close();
  });

  test("a second run claims nothing new (idempotent) and the owner keeps access", async ({ request }) => {
    claimLegacyData();

    const dto = await apiGet<{ analysis: { id: string } }>(request, `/api/jobs/${seedState.legacy.analysisId}`);
    expect(dto.analysis.id).toBe(seedState.legacy.analysisId);
  });
});
