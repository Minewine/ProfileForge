
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import {
  addBullet,
  deleteEntry,
  entryById,
  openProfile,
  setEntryField,
  versionRows,
} from "./support/editor";
import { apiGet, apiPost, type SeedStateFile } from "./support/env";

const seedState: SeedStateFile = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests", "e2e", ".seed-state.json"), "utf8"),
);

type VersionsBody = { currentVersion: number; versions: Array<{ version: number; cause: string }> };

test.describe("US5 — edits remain usable by generation, Fact Guard, and version history", () => {
  test("after UI CRUD, claim validation grounds against the edited profile and every change is versioned (FR-017)", async ({
    page,
    request,
  }) => {
    await openProfile(page);

    // A round of representative CRUD through the editor UI.
    const added = page.waitForResponse(
      (r) => r.url().includes("/api/profile/entries/experience") && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("add-experience").click();
    const created = (await (await added).json()) as { id: string };
    const entry = entryById(page, "experience", created.id);

    await setEntryField(page, "experience", created.id, "company", "Downstream Co");
    await addBullet(entry, "Grounded downstream bullet.", page);

    // Fact Guard runs against the edited profile: clean user-entered content grounds.
    await page.getByTestId("validate-claims").click();
    await expect(page.getByText("All claims are grounded in profile evidence.")).toBeVisible();

    // The mutations were recorded (FR-017) and the editor still works after.
    const versions = await apiGet<VersionsBody>(request, "/api/profile/versions");
    expect(versions.versions[0].cause).toBe("edit");
    await deleteEntry(page, "experience", created.id);
    await expect(entryById(page, "experience", created.id)).toHaveCount(0);

    // The seeded generation (pinned snapshot, no AI key in this harness) still
    // renders its succeeded view after the suite's UI CRUD (US5, SC-006).
    await page.goto(`/jobs/${seedState.generation.analysisId}`);
    await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Senior Platform Engineer — Acme Analytics").first()).toBeVisible();
  });

  test("restored version content is editable like live content (FR-019)", async ({ page, request }) => {
    const before = await apiGet<VersionsBody>(request, "/api/profile/versions");
    await apiPost(request, "/api/profile/entries/languages", { name: "Restore Probe" });

    await openProfile(page);
    const target = before.currentVersion; // the snapshot just before the create
    const restored = page.waitForResponse(
      (r) => r.url().includes("/api/profile/versions") && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await versionRows(page)
      .filter({ hasText: `v${target} ` })
      .getByRole("button", { name: "Restore" })
      .click();
    await restored;

    // Restore reinserts entries with NEW ids — resolve one fresh and edit it.
    const profile = await apiGet<{
      profile: { skills: Array<{ id: string; name: string | null }> };
    }>(request, "/api/profile");
    const kubernetes = profile.profile.skills.find((s) => s.name === "Kubernetes")!;

    await setEntryField(page, "skills", kubernetes.id, "category", "Restored & edited");
    await page.reload();
    const entry = entryById(page, "skills", kubernetes.id);
    await expect(entry.getByRole("textbox", { name: "Category" })).toHaveValue("Restored & edited");
    await setEntryField(page, "skills", kubernetes.id, "category", "");
    await page.reload();
    await expect(entryById(page, "skills", kubernetes.id).getByRole("textbox", { name: "Category" })).toHaveValue("");
  });
});
