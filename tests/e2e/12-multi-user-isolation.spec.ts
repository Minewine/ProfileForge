import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * US2 two-user isolation (specs/008, quickstart Scenario 3 / SC-003): account A
 * creates data; account B sees none of it — not in listings, not via direct
 * URLs, not via direct API calls.
 */
test.describe.serial("US2 — two-user data isolation", () => {
  const ALICE = "alice-multi@example.com";
  const BOB = "bob-multi@example.com";
  const PASSWORD = "password-123";
  const JD_HEADING = "Isolation probe: Senior Kubernetes Goat Herder";

  let aliceJobUrl: string;

  async function register(page: Page, email: string) {
    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    // The nav must show THIS account — proves a real registration happened
    // rather than a redirect of an already-authenticated session.
    await expect(page.getByText(email)).toBeVisible();
  }

  async function createJobAsAlice(page: Page) {
    await page.goto("/jobs");
    await page.getByLabel("Job description text").fill(
      `${JD_HEADING}. We require strong experience in distributed systems and Kubernetes.
You must have at least 5 years of Go development. A Bachelor's degree in Computer Science is required.
Nice to have: Kafka, Terraform. French language skills are a plus for our Montreal office.`,
    );
    await page.getByRole("button", { name: /analyze|create|submit/i }).click();
    await page.waitForURL(/\/jobs\/[^/]+$/);
    aliceJobUrl = page.url();
    expect(aliceJobUrl).toMatch(/\/jobs\/[^/]+$/);
  }

  test("alice creates a job analysis; bob starts from an empty workspace", async ({ page, browser }) => {
    await register(page, ALICE);
    await createJobAsAlice(page);

    // Bob in a separate browser context — explicitly signed out.
    const bobCtx = await (browser as Browser).newContext({ storageState: { cookies: [], origins: [] } });
    const bobPage = await bobCtx.newPage();
    await register(bobPage, BOB);
    await bobPage.goto("/jobs");
    await expect(bobPage.getByText(JD_HEADING)).toHaveCount(0);
    await bobCtx.close();
  });

  test("bob cannot reach alice's analysis by URL or API", async ({ browser }) => {
    const jobId = aliceJobUrl.split("/").pop() as string;

    const bobCtx = await (browser as Browser).newContext({ storageState: { cookies: [], origins: [] } });
    const bobPage = await bobCtx.newPage();
    await register(bobPage, "carol-multi@example.com"); // fresh account — bob already exists from test 1
    await bobPage.goto(aliceJobUrl);
    await expect(bobPage.getByText(JD_HEADING)).toHaveCount(0); // no content leak

    // Even a direct API call from Bob's own session gets NOT_FOUND, never data.
    const res = await bobCtx.request.get(`/api/jobs/${jobId}`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    await bobCtx.close();
  });

  test("alice still sees her analysis after bob's attempts", async ({ browser }) => {
    const ctx = await (browser as Browser).newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.getByLabel("Email").fill(ALICE);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/profile$/);

    await page.goto("/jobs");
    await expect(page.getByText(JD_HEADING)).toBeVisible();
    await ctx.close();
  });
});
