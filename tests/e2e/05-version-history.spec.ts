
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import { deleteEntry, openProfile, setEntryField, versionRows } from "./support/editor";
import { apiGet, apiPost } from "./support/env";

type VersionsBody = {
  currentVersion: number;
  versions: Array<{ version: number; cause: string; createdAt: string }>;
};

test.describe("US5 — version history captures the edits", () => {
  test("three persisted edits advance the version by exactly three with edit causes", async ({ page, request }) => {
    await openProfile(page);
    const before = await apiGet<VersionsBody>(request, "/api/profile/versions");

    // Three known persisted mutations: create, field edit, delete.
    const lang = await apiPost<{ id: string }>(request, "/api/profile/entries/languages", { name: "Italian" });
    const body = await apiGet<{ profile: { experience: Array<{ id: string; company: string | null }> } }>(
      request,
      "/api/profile",
    );
    const acme = body.profile.experience.find((e) => e.company === "Acme Analytics")!;
    await setEntryField(page, "experience", acme.id, "location", `Montreal (edit ${Date.now()})`); // autosaves, always a change
    await deleteEntry(page, "languages", lang.id);

    const after = await apiGet<VersionsBody>(request, "/api/profile/versions");
    expect(after.currentVersion).toBe(before.currentVersion + 3);
    const newestThree = after.versions.slice(0, 3);
    expect(newestThree.map((v) => v.cause)).toEqual(["edit", "edit", "edit"]);
    expect(newestThree.map((v) => v.version)).toEqual([
      before.currentVersion + 3,
      before.currentVersion + 2,
      before.currentVersion + 1,
    ]);

    // The UI renders the same stored history; identical after a reload.
    const uiFirst = versionRows(page).first();
    await expect(uiFirst).toContainText(`v${after.currentVersion}`);
    await page.reload();
    const again = await apiGet<VersionsBody>(request, "/api/profile/versions");
    expect(again).toEqual(after);
    await expect(versionRows(page).first()).toContainText(`v${after.currentVersion}`);
  });

  test("restoring an earlier version reverts content and records a restore cause", async ({ page, request }) => {
    await openProfile(page);
    const before = await apiGet<VersionsBody>(request, "/api/profile/versions");

    // Create something disposable, then restore the version just before it.
    const lang = await apiPost<{ id: string }>(request, "/api/profile/entries/languages", { name: "Disposable" });
    const target = before.currentVersion; // the snapshot just before the create
    const restored = page.waitForResponse((r) => r.url().includes("/api/profile/versions") && r.request().method() === "POST");
    await versionRows(page)
      .filter({ hasText: `v${target} ` })
      .getByRole("button", { name: "Restore" })
      .click();
    await restored;

    const after = await apiGet<VersionsBody>(request, "/api/profile/versions");
    expect(after.currentVersion).toBe(before.currentVersion + 2); // create + restore
    expect(after.versions[0].cause).toBe("restore");
    const profile = await apiGet<{ profile: { languages: Array<{ id: string; name: string | null }> } }>(
      request,
      "/api/profile",
    );
    expect(profile.profile.languages.find((l) => l.id === lang.id)).toBeUndefined();
  });
});
