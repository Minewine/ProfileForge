import { defineConfig } from "@playwright/test";

/**
 * E2E suite config (specs/004-profile-editing-e2e, contracts/e2e-suite.md):
 * the app under test is the production build on a scratch port, pointed at the
 * physically isolated e2e database (compose `e2e-db`, port 5434) and its own
 * uploads dir. Serial by design — scenarios share the seeded profile and the
 * file order is the run state machine (data-model.md); the inconsistent
 * claim-validation fixture is applied last by the seed, so provenance-claims
 * must stay the final spec.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  globalSetup: "./tests/e2e/scripts/seed.ts",
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npx next start -p 3100",
    port: 3100,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: "postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e",
      UPLOADS_DIR: "./uploads-e2e",
    },
  },
});
