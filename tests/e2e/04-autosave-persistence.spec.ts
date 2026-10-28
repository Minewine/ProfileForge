
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import {
  bulletTextareas,
  deleteEntry,
  entryById,
  openProfile,
  setEntryField,
  waitForAutosave,
} from "./support/editor";
import { apiGet, apiPost } from "./support/env";

type ExperienceDto = { id: string; company: string | null };

/** Create a disposable experience entry (bullets ride along at create time). */
async function createExperience(
  request: import("@playwright/test").APIRequestContext,
  overrides: Record<string, unknown> = {},
) {
  return apiPost<{ id: string }>(request, "/api/profile/entries/experience", {
    company: `Autosave Probe ${Date.now()}`,
    title: "Engineer",
    ...overrides,
  });
}

test.describe("US4 — autosave persists across reload", () => {
  test("an edit confirmed at the network level survives reload", async ({ page, request }) => {
    await openProfile(page);
    const body = await apiGet<{ profile: { experience: ExperienceDto[] } }>(request, "/api/profile");
    const acme = body.profile.experience.find((e) => e.company === "Acme Analytics")!;

    // setEntryField resolves only after the debounced PATCH returns 200.
    await setEntryField(page, "experience", acme.id, "location", "Montreal (hybrid)");
    await page.reload();
    await expect(entryById(page, "experience", acme.id).getByRole("textbox", { name: "Location" })).toHaveValue(
      "Montreal (hybrid)",
    );
  });

  test("an edit abandoned before the debounce fires does not persist", async ({ page, request }) => {
    await openProfile(page);
    const body = await apiGet<{ profile: { experience: ExperienceDto[] } }>(request, "/api/profile");
    const acme = body.profile.experience.find((e) => e.company === "Acme Analytics")!;
    const locationField = entryById(page, "experience", acme.id).getByRole("textbox", { name: "Location" });

    const priorValue = await locationField.inputValue();
    await locationField.fill("Montreal (abandoned draft)");
    // Reload BEFORE the 800 ms debounce can fire — no PATCH may have been sent.
    await page.reload();
    await expect(entryById(page, "experience", acme.id).getByRole("textbox", { name: "Location" })).toHaveValue(
      priorValue,
    );
  });

  test("basics edits autosave through PATCH /api/profile and survive reload", async ({ page }) => {
    await openProfile(page);
    const headline = page.locator("#basics-headline");
    const saved = waitForAutosave(page);
    await headline.fill("Principal Platform Engineer");
    await saved;
    await page.reload();
    await expect(page.locator("#basics-headline")).toHaveValue("Principal Platform Engineer");
  });

  test("editing a field on an entry that has bullets leaves the bullets untouched (SC-002)", async ({
    page,
    request,
  }) => {
    const created = await createExperience(request, {
      bullets: [{ text: "Autosave probe bullet one.", order: 0 }, { text: "Autosave probe bullet two.", order: 1 }],
    });
    await openProfile(page);

    await setEntryField(page, "experience", created.id, "location", "Remote");
    await page.reload();

    const reloaded = entryById(page, "experience", created.id);
    await expect(reloaded.getByRole("textbox", { name: "Location" })).toHaveValue("Remote");
    await expect(bulletTextareas(reloaded)).toHaveCount(2);
    await expect(bulletTextareas(reloaded).nth(0)).toHaveValue("Autosave probe bullet one.");
    await expect(bulletTextareas(reloaded).nth(1)).toHaveValue("Autosave probe bullet two.");
    await deleteEntry(page, "experience", created.id);
  });

  test("rewording a bullet persists across reload", async ({ page, request }) => {
    const created = await createExperience(request, {
      bullets: [{ text: "Original bullet wording.", order: 0 }],
    });
    await openProfile(page);
    const entry = entryById(page, "experience", created.id);
    const reword = page.waitForResponse(
      (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout: 10_000 },
    );
    await bulletTextareas(entry).nth(0).fill("Reworded after the fact.");
    await reword;

    await page.reload();
    await expect(bulletTextareas(entryById(page, "experience", created.id)).nth(0)).toHaveValue(
      "Reworded after the fact.",
    );
    await deleteEntry(page, "experience", created.id);
  });

  test("clearing an optional date saves as empty (no error) and persists", async ({ page, request }) => {
    const created = await createExperience(request, { startDate: "2021-03", endDate: "2022-05" });
    await openProfile(page);

    // Clearing sends null (never ""), so the save succeeds — spec FR-005.
    await setEntryField(page, "experience", created.id, "endDate", "");
    await page.reload();

    await expect(entryById(page, "experience", created.id).getByRole("textbox", { name: "End" })).toHaveValue("");
    await expect(entryById(page, "experience", created.id).getByRole("textbox", { name: "Start" })).toHaveValue(
      "2021-03",
    );
    await deleteEntry(page, "experience", created.id);
  });

  test("two rapid successive edits to different fields of one entry both persist", async ({ page, request }) => {
    const created = await createExperience(request);
    await openProfile(page);
    const entry = entryById(page, "experience", created.id);

    // Type into two fields back-to-back, before either 800 ms debounce fires;
    // each field has its own timer, so both PATCHes must land and stick.
    // Two SEQUENTIAL waits: same-predicate parallel waiters would both latch
    // onto the first save's response and let the reload abort the second one
    // mid-flight (observed as a status -1 PATCH in the failing trace).
    const patch200 = (r: {
      url: () => string;
      request: () => { method: () => string };
      status: () => number;
    }) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200;
    await entry.getByRole("textbox", { name: "Location" }).fill("Lyon");
    await entry.getByRole("textbox", { name: "Title" }).fill("Staff Engineer");
    await page.waitForResponse(patch200, { timeout: 10_000 });
    await page.waitForResponse(patch200, { timeout: 10_000 });

    await page.reload();
    const reloaded = entryById(page, "experience", created.id);
    await expect(reloaded.getByRole("textbox", { name: "Location" })).toHaveValue("Lyon");
    await expect(reloaded.getByRole("textbox", { name: "Title" })).toHaveValue("Staff Engineer");
    await deleteEntry(page, "experience", created.id);
  });

  test("two rapid successive edits to two different bullets of one entry both persist (FR-020)", async ({
    page,
    request,
  }) => {
    const created = await createExperience(request, {
      bullets: [{ text: "Alpha.", order: 0 }, { text: "Beta.", order: 1 }],
    });
    await openProfile(page);
    const entry = entryById(page, "experience", created.id);

    // Bullets share one autosave timer per entry: the second edit's payload
    // must compose the first edit, not replace it with a stale copy — a single
    // PATCH carries both reworded bullets.
    const patch = page.waitForResponse(
      (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout: 10_000 },
    );
    await bulletTextareas(entry).nth(0).fill("Alpha revised.");
    await bulletTextareas(entry).nth(1).fill("Beta revised.");
    await patch;

    await page.reload();
    const reloaded = bulletTextareas(entryById(page, "experience", created.id));
    await expect(reloaded).toHaveCount(2);
    await expect(reloaded.nth(0)).toHaveValue("Alpha revised.");
    await expect(reloaded.nth(1)).toHaveValue("Beta revised.");
    await deleteEntry(page, "experience", created.id);
  });

  test("typing during the save→refetch window is not reverted (contract-editor-ui)", async ({
    page,
    request,
  }) => {
    const created = await createExperience(request, { bullets: [{ text: "Alpha.", order: 0 }] });
    await openProfile(page);
    const textarea = bulletTextareas(entryById(page, "experience", created.id)).nth(0);

    // Hold PATCH responses ~1.5s so the save→refetch cycle lands while newer
    // typing exists locally.
    await page.route("**/api/profile/entries/**", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // The test may reload while this held response is pending (the page
      // aborts the request) — an aborted route is already handled.
      await route.fulfill({ response }).catch(() => undefined);
    });

    const sent = page.waitForRequest(
      (r) => r.url().includes("/api/profile/entries/") && r.method() === "PATCH",
      { timeout: 10_000 },
    );
    await textarea.fill("Alpha revised");
    await sent; // PATCH in flight, its response held

    // A newer edit while the first save's response (and the refetch it
    // triggers) is still pending — reconciliation must keep this text.
    await textarea.fill("Alpha revised plus more");
    const firstSave = page.waitForResponse(
      (r) => r.url().includes("/api/profile/entries/") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout: 10_000 },
    );
    await firstSave; // the held first save's response
    // The second save's response rides the same 1.5s hold — it must land before
    // the reload, or the reload aborts it mid-flight (harness race, not app).
    await page.waitForResponse(
      (r) => r.url().includes("/api/profile/entries/") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout: 10_000 },
    );
    await expect(textarea).toHaveValue("Alpha revised plus more");

    await page.unroute("**/api/profile/entries/**");
    await page.reload();
    await expect(bulletTextareas(entryById(page, "experience", created.id)).nth(0)).toHaveValue(
      "Alpha revised plus more",
    );
    await deleteEntry(page, "experience", created.id);
  });

  test("basics links save as a list and survive reload (FR-001)", async ({ page }) => {
    await openProfile(page);
    const links = page.locator("#basics-links");
    const saved = waitForAutosave(page);
    await links.fill("https://github.com/example\nhttps://www.example.dev");
    await saved;
    await page.reload();
    await expect(page.locator("#basics-links")).toHaveValue(
      "https://github.com/example\nhttps://www.example.dev",
    );
    // Leave the seeded profile without test links.
    await page.locator("#basics-links").fill("");
    await waitForAutosave(page);
  });
});
