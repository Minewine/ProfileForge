
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import {
  addBullet,
  bulletTextareas,
  deleteEntry,
  entryById,
  openProfile,
  removeBullet,
  section,
  setEntryField,
} from "./support/editor";

test.describe("US2 — experience CRUD, including bullets and roles", () => {
  test("add → edit fields → add/edit/remove bullets → remove, all persisted", async ({ page }) => {
    await openProfile(page);

    // 1. "+ Add" creates an editable placeholder row through the UI (spec 007 D4).
    const added = page.waitForResponse(
      (r) => r.url().includes("/api/profile/entries/experience") && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await section(page, "experience").getByTestId("add-experience").click();
    const created = (await (await added).json()) as { id: string };
    const entry = entryById(page, "experience", created.id);
    await expect(entry).toBeVisible();

    await setEntryField(page, "experience", created.id, "company", "Nordwind Labs");
    await setEntryField(page, "experience", created.id, "title", "Platform Engineer");
    await setEntryField(page, "experience", created.id, "location", "Berlin");
    await setEntryField(page, "experience", created.id, "startDate", "2020-01");
    await setEntryField(page, "experience", created.id, "endDate", "2020-12");

    // 2. Bullets are added through the UI: "+ Bullet" drafts locally, the text
    // PATCH persists it (spec 007 D3).
    await addBullet(entry, "Shipped the migration pipeline.", page);
    await addBullet(entry, "Cut deploy time from 40 to 6 minutes.", page);
    await addBullet(entry, "Hired two engineers.", page);

    await page.reload();
    const reloaded = entryById(page, "experience", created.id);
    await expect(reloaded.getByRole("textbox", { name: "Title" })).toHaveValue("Platform Engineer");
    await expect(bulletTextareas(reloaded)).toHaveCount(3);
    await expect(bulletTextareas(reloaded).nth(0)).toHaveValue("Shipped the migration pipeline.");
    await expect(bulletTextareas(reloaded).nth(1)).toHaveValue("Cut deploy time from 40 to 6 minutes.");
    await expect(bulletTextareas(reloaded).nth(2)).toHaveValue("Hired two engineers.");

    // 3. Bullet edit and remove through the editor — exact list after each op.
    await bulletTextareas(reloaded).nth(0).fill("Shipped the zero-downtime migration pipeline.");
    await page.waitForResponse(
      (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout: 10_000 },
    );
    const afterEdit = bulletTextareas(entryById(page, "experience", created.id));
    await expect(afterEdit.nth(0)).toHaveValue("Shipped the zero-downtime migration pipeline.");
    await removeBullet(entryById(page, "experience", created.id), 1, page);
    const afterRemove = bulletTextareas(entryById(page, "experience", created.id));
    await expect(afterRemove).toHaveCount(2);
    await expect(afterRemove.nth(0)).toHaveValue("Shipped the zero-downtime migration pipeline.");
    await expect(afterRemove.nth(1)).toHaveValue("Hired two engineers.");
    await page.reload();
    const afterReload = bulletTextareas(entryById(page, "experience", created.id));
    await expect(afterReload).toHaveCount(2);
    await expect(afterReload.nth(0)).toHaveValue("Shipped the zero-downtime migration pipeline.");
    await expect(afterReload.nth(1)).toHaveValue("Hired two engineers.");

    // 4. Removal: gone from the UI, after reload, and stable there.
    await deleteEntry(page, "experience", created.id);
    await expect(entryById(page, "experience", created.id)).toHaveCount(0);
    await page.reload();
    await expect(entryById(page, "experience", created.id)).toHaveCount(0);
  });
});
