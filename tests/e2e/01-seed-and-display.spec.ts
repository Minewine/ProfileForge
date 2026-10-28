
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import { openProfile, section } from "./support/editor";
import { apiGet, type SeedStateFile } from "./support/env";

const seedState: SeedStateFile = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests", "e2e", ".seed-state.json"), "utf8"),
);

test.describe("US1 — seed sample data and see the profile", () => {
  test("every seeded entry displays in its correct section with provenance", async ({ page }) => {
    await openProfile(page);

    // Experience: the three seeded entries by company (values are input values).
    const experience = section(page, "experience");
    const companies = experience.getByRole("textbox", { name: "Company" });
    await expect(companies).toHaveCount(3);
    await expect(companies.nth(0)).toHaveValue("Acme Analytics");
    await expect(companies.nth(1)).toHaveValue("Globex Systems");
    await expect(companies.nth(2)).toHaveValue("Société Générale du Logiciel"); // FR entry verbatim
    await expect(experience.getByRole("textbox", { name: "Title" }).nth(0)).toHaveValue("Senior Platform Engineer");
    await expect(experience.getByRole("textbox", { name: "Title" }).nth(2)).toHaveValue("Ingénieur logiciel");
    await expect(experience.getByRole("textbox", { name: "Start" }).nth(0)).toHaveValue("2021-03");
    await expect(experience.getByRole("textbox", { name: "End" }).nth(0)).toHaveValue("present");
    // Bullets are textarea values (accented FR text round-trips); bullets have
    // no accessible label — anchor on their testids.
    await expect(experience.locator('textarea[data-testid^="bullet-"]').nth(0)).toHaveValue(
      "Operated Kubernetes clusters serving 2M requests per day.",
    );

    // Education, skills (levels user-stated), languages, projects, certifications.
    await expect(section(page, "education").getByRole("textbox", { name: "Institution" })).toHaveCount(1);
    await expect(section(page, "education").getByRole("textbox", { name: "Institution" })).toHaveValue("McGill University");
    const skills = section(page, "skills");
    // Skill rows may render in either order (both seed with order 0) — assert
    // the name set, then each entry's level via its input id.
    const skillNames = await skills
      .getByRole("textbox", { name: "Name" })
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort());
    expect(skillNames).toEqual(["Go", "Kubernetes"]);
    const idOf = (name: string) =>
      skills.getByRole("textbox", { name: "Name" }).evaluateAll(
        (els, wanted) => (els as HTMLInputElement[]).find((e) => e.value === wanted)?.id.replace("-name", "") ?? "",
        name,
      );
    const kubernetesId = await idOf("Kubernetes");
    await expect(page.locator(`#${kubernetesId}-level`)).toHaveValue("Expert");
    const goId = await idOf("Go");
    await expect(page.locator(`#${goId}-level`)).toHaveValue(""); // no inferred level
    await expect(section(page, "languages").getByRole("textbox", { name: "Language" })).toHaveCount(2);
    await expect(section(page, "projects").getByRole("textbox", { name: "Project" })).toHaveValue("ATS Checker");
    await expect(section(page, "certifications").getByRole("textbox", { name: "Certification" })).toHaveValue(
      "Certified Kubernetes Administrator",
    );

    // Provenance is visible and attributable (seeded = user-entered, never blank).
    const badges = await page.getByText("user-entered", { exact: true }).count();
    expect(badges).toBeGreaterThanOrEqual(9); // 3 experience + education + 2 skills + 2 languages + project + cert

    // The inconsistent fixture flags the first experience entry for review.
    await expect(page.getByText("1 review flags")).toBeVisible();

    // Header version badge matches the seeded state.
    await expect(page.getByText(`v${seedState.profileVersionAfterSeed}`, { exact: true })).toBeVisible();
  });

  test("the rendered profile matches the stored profile (API cross-check)", async ({ request }) => {
    const body = await apiGet<{
      profile: Record<string, Array<Record<string, unknown>>>;
      lowConfidenceCount: number;
    }>(request, "/api/profile");
    expect(body.profile.experience).toHaveLength(3);
    expect(body.profile.education).toHaveLength(1);
    expect(body.profile.skills).toHaveLength(2);
    expect(body.profile.languages).toHaveLength(2);
    expect(body.profile.projects).toHaveLength(1);
    expect(body.profile.certifications).toHaveLength(1);
    expect(body.lowConfidenceCount).toBe(1);
  });
});
