import { expect, test } from "@playwright/test";

/**
 * US1 auth flows (specs/008, quickstart Scenarios 1–2). Serial: later tests
 * reuse the account created earlier. Each test starts in a fresh browser
 * context (signed out by default).
 */
test.describe.serial("US1 — register, log in, private workspace", () => {
  const EMAIL = "auth-flows@example.com";
  const PASSWORD = "password-123";

  test("logged-out visitors see only login/register — never app data", async ({ page, request }) => {
    for (const path of ["/", "/profile", "/upload", "/jobs", "/settings"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    }
    // Data APIs answer 401, never data.
    const res = await request.get("/api/profile");
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  test("register creates the account and lands in an empty private workspace", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByText(EMAIL)).toBeVisible(); // nav identity
  });

  test("wrong password shows a generic error and creates no session", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill("totally-wrong-pass");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p[role='alert']")).toHaveText("Invalid email or password.");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("sign out locks the browser out; signing back in restores the workspace", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByText(EMAIL)).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/profile");
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/profile$/);
  });

  test("duplicate registration is rejected without creating an account", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill(EMAIL.toUpperCase()); // same account, different case
    await page.getByLabel("Password").fill("another-pass-456");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.locator("p[role='alert']")).toContainText("already exists");
    await expect(page).toHaveURL(/\/register$/);
  });
});
