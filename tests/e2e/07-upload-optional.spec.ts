
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import path from "node:path";
import { openProfile, section } from "./support/editor";

/**
 * FR-002's optional scenario: the upload → parse → import flow (US1's second
 * CV / bilingual edge case). It needs a real OpenRouter key for the parse —
 * skipped unless explicitly provided — and then exercises: upload the French
 * fixture after the English seed, the replace-or-merge decision, and the
 * guarantee that user-entered entries are preserved.
 */
test.skip(!process.env.OPENROUTER_API_KEY, "requires OPENROUTER_API_KEY (live parse)");

test.describe("US1 optional — CV upload and parse (key-gated)", () => {
  test("upload + parse the French fixture; import preserves user-entered entries", async ({ page }) => {
    await page.goto("/upload");
    await page.setInputFiles('input[type="file"]', path.join(process.cwd(), "tests", "fixtures", "cv-fr.pdf"));
    await expect(page.getByText(/parsed/i).first()).toBeVisible({ timeout: 60_000 });

    // Import merges by default; the seeded (user-entered) entries must survive.
    await openProfile(page);
    await expect(section(page, "experience").getByRole("textbox", { name: "Company" }).first()).toHaveValue(
      "Acme Analytics",
    );
  });
});
