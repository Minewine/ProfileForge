
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import { deleteEntry, entryById, openProfile, saveStatus, setEntryField } from "./support/editor";
import { apiDelete, apiGet, apiPost } from "./support/env";

type ExperienceDto = { id: string; company: string | null; startDate: string | null; endDate: string | null };
type BasicsDto = { name: string | null; email: string | null };

const patchFailed = (page: import("@playwright/test").Page, status: number) =>
  page.waitForResponse(
    (r) =>
      (r.url().endsWith("/api/profile") || r.url().includes("/api/profile/entries/")) &&
      r.request().method() === "PATCH" &&
      r.status() === status,
    { timeout: 10_000 },
  );

test.describe("US4b — every save outcome is visible (FR-012…FR-016)", () => {
  test("clearing the required name shows a specific error and is not silently reverted", async ({ page, request }) => {
    const before = await apiGet<{ profile: { basics: BasicsDto } }>(request, "/api/profile");
    const savedName = before.profile.basics.name ?? "";
    expect(savedName).toBeTruthy();

    await openProfile(page);
    const failed = patchFailed(page, 400);
    await page.locator("#basics-name").fill("");
    await failed;

    const errorLine = page.getByTestId("save-error");
    await expect(errorLine).toBeVisible();
    await expect(errorLine).toContainText("Profile basics");
    await expect(errorLine).toContainText("name");
    await expect(saveStatus(page)).toContainText("Failed");

    // The typed (invalid) state is not hidden, but a reload shows the last saved value.
    await page.reload();
    await expect(page.locator("#basics-name")).toHaveValue(savedName);
    await expect(page.getByTestId("save-error")).toHaveCount(0);
  });

  test("an invalid email shows a validation error", async ({ page }) => {
    await openProfile(page);
    const failed = patchFailed(page, 400);
    await page.locator("#basics-email").fill("not-an-email");
    await failed;

    const errorLine = page.getByTestId("save-error");
    await expect(errorLine).toBeVisible();
    await expect(errorLine).toContainText("email");
  });

  test("an unreachable server surfaces a failure message on the entry save path", async ({ page, request }) => {
    const body = await apiGet<{ profile: { experience: ExperienceDto[] } }>(request, "/api/profile");
    const acme = body.profile.experience.find((e) => e.company === "Acme Analytics")!;

    await openProfile(page);
    // Block only PATCHes; the page's GETs must keep working.
    await page.route("**/api/profile/**", (route) =>
      route.request().method() === "PATCH" ? route.abort() : route.fallback(),
    );
    await entryFieldFill(page, acme.id, "Remote-off");
    const errorLine = page.getByTestId("save-error");
    await expect(errorLine).toBeVisible();
    await expect(errorLine).toContainText("could not reach the server");
    await page.unroute("**/api/profile/**");
  });

  test("overlapping dates show a warning while the save still succeeds (FR-016)", async ({ page, request }) => {
    const body = await apiGet<{ profile: { experience: ExperienceDto[] } }>(request, "/api/profile");
    const acme = body.profile.experience.find((e) => e.company === "Acme Analytics")!;

    // Create an experience overlapping Acme's dates through the API.
    const overlap = await apiPost<{ id: string }>(request, "/api/profile/entries/experience", {
      company: `Warn Co ${Date.now()}`,
      title: "Consultant",
      startDate: acme.startDate ?? "2021-01",
      endDate: acme.endDate ?? "present",
    });

    await openProfile(page);
    const saved = page.waitForResponse(
      (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout: 10_000 },
    );
    await setEntryField(page, "experience", overlap.id, "location", "Brussels");
    await saved;

    await expect(page.getByTestId("save-warning")).toBeVisible();
    await expect(page.getByTestId("save-warning")).toContainText("DATE_RANGE_OVERLAP");
    await expect(saveStatus(page)).toContainText("Saved · v");
    await expect(page.getByTestId("save-error")).toHaveCount(0);

    await apiDelete(request, `/api/profile/entries/experience/${overlap.id}`);
  });

  test("a successful save clears a previous error", async ({ page, request }) => {
    const body = await apiGet<{ profile: { experience: ExperienceDto[] } }>(request, "/api/profile");
    const acme = body.profile.experience.find((e) => e.company === "Acme Analytics")!;

    await openProfile(page);
    const failed = patchFailed(page, 400);
    await page.locator("#basics-email").fill("nope");
    await failed;
    await expect(page.getByTestId("save-error")).toBeVisible();

    await setEntryField(page, "experience", acme.id, "location", "Clears the error");
    await expect(page.getByTestId("save-error")).toHaveCount(0);
    await expect(saveStatus(page)).toContainText("Saved · v");
  });

  test("deleting an entry right after typing leaves no spurious error (spec edge case 6)", async ({
    page,
    request,
  }) => {
    const created = await apiPost<{ id: string }>(request, "/api/profile/entries/experience", {
      company: `Ghost Co ${Date.now()}`,
      title: "X",
    });
    await openProfile(page);

    // Type (schedules an autosave) then delete before the debounce fires — the
    // pending timer must be cancelled, not 404 into an error banner.
    await page.locator(`#entry-experience-${created.id}-location`).fill("soon-gone");
    await deleteEntry(page, "experience", created.id);
    await expect(entryById(page, "experience", created.id)).toHaveCount(0);

    // A later successful save proves the page settled with no stale 404 error.
    const body = await apiGet<{ profile: { experience: Array<{ id: string; company: string | null }> } }>(
      request,
      "/api/profile",
    );
    const acme = body.profile.experience.find((e) => e.company === "Acme Analytics")!;
    await setEntryField(page, "experience", acme.id, "location", `Settled ${Date.now()}`);
    await expect(page.getByTestId("save-error")).toHaveCount(0);
    await expect(saveStatus(page)).toContainText("Saved · v");
  });
});

async function entryFieldFill(page: import("@playwright/test").Page, entryId: string, value: string): Promise<void> {
  await page.locator(`#entry-experience-${entryId}-location`).fill(value);
}
