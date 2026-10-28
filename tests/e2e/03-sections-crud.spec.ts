
import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import { addButton, deleteEntry, entryById, openProfile, section, setEntryField } from "./support/editor";
import { BASE_URL, apiGet, apiPost, type SectionName } from "./support/env";

type EntryDto = { id: string; name?: string | null; institution?: string | null; title?: string | null; level?: string | null };

async function sectionEntries(request: APIRequestContext, name: string) {
  const body = await apiGet<{ profile: Record<string, EntryDto[]> }>(request, "/api/profile");
  return body.profile[name];
}

/** Click "+ Add" and resolve the created entry id from the POST response. */
async function addViaUi(page: Page, name: SectionName): Promise<string> {
  const added = page.waitForResponse(
    (r) => r.url().includes(`/api/profile/entries/${name}`) && r.request().method() === "POST",
    { timeout: 10_000 },
  );
  await addButton(page, name).click();
  const created = (await (await added).json()) as { id: string };
  return created.id;
}

test.describe("US3 — CRUD across languages, skills, education, projects, certifications", () => {
  // Spec 007: "+ Add" works in every section (placeholder payloads, research
  // D4) — entries are created, edited, and removed entirely through the UI.
  test("+ Add creates, edits, and removes an entry in each of the five sections", async ({ page }) => {
    await openProfile(page);

    // Languages.
    const langId = await addViaUi(page, "languages");
    await setEntryField(page, "languages", langId, "proficiency", "Fluent");
    await page.reload();
    await expect(entryById(page, "languages", langId).getByRole("textbox", { name: "Language" })).toHaveValue(
      "New language",
    );
    await expect(entryById(page, "languages", langId).getByRole("textbox", { name: "Proficiency" })).toHaveValue(
      "Fluent",
    );
    await deleteEntry(page, "languages", langId);

    // Skills.
    const skillId = await addViaUi(page, "skills");
    await setEntryField(page, "skills", skillId, "name", "Terraform");
    await setEntryField(page, "skills", skillId, "category", "Infrastructure");
    await page.reload();
    const skillEntry = entryById(page, "skills", skillId);
    await expect(skillEntry.getByRole("textbox", { name: "Name" })).toHaveValue("Terraform");
    await expect(skillEntry.getByRole("textbox", { name: "Category" })).toHaveValue("Infrastructure");
    await deleteEntry(page, "skills", skillId);

    // Education.
    const eduId = await addViaUi(page, "education");
    await setEntryField(page, "education", eduId, "degree", "MSc with distinction");
    await page.reload();
    const eduEntry = entryById(page, "education", eduId);
    await expect(eduEntry.getByRole("textbox", { name: "Institution" })).toHaveValue("New education");
    await expect(eduEntry.getByRole("textbox", { name: "Degree" })).toHaveValue("MSc with distinction");
    await deleteEntry(page, "education", eduId);

    // Projects.
    const projectId = await addViaUi(page, "projects");
    await setEntryField(page, "projects", projectId, "description", "Dashboards for operations teams.");
    await page.reload();
    const projectEntry = entryById(page, "projects", projectId);
    await expect(projectEntry.getByRole("textbox", { name: "Project" })).toHaveValue("New project");
    await expect(projectEntry.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Dashboards for operations teams.",
    );
    await deleteEntry(page, "projects", projectId);

    // Certifications.
    const certId = await addViaUi(page, "certifications");
    await setEntryField(page, "certifications", certId, "issuer", "Cloud Native Computing Foundation");
    await page.reload();
    const certEntry = entryById(page, "certifications", certId);
    await expect(certEntry.getByRole("textbox", { name: "Certification" })).toHaveValue("New certification");
    await expect(certEntry.getByRole("textbox", { name: "Issuer" })).toHaveValue(
      "Cloud Native Computing Foundation",
    );
    await deleteEntry(page, "certifications", certId);

    await page.reload();
    await expect(entryById(page, "languages", langId)).toHaveCount(0);
    await expect(entryById(page, "skills", skillId)).toHaveCount(0);
    await expect(entryById(page, "education", eduId)).toHaveCount(0);
    await expect(entryById(page, "projects", projectId)).toHaveCount(0);
    await expect(entryById(page, "certifications", certId)).toHaveCount(0);
  });

  test("adding to an empty section works (empty state, then a usable entry)", async ({ page, request }) => {
    // Make certifications deterministically empty, then exercise "+ Add".
    const certs = await sectionEntries(request, "certifications");
    for (const c of certs) {
      await request.delete(`${BASE_URL}/api/profile/entries/certifications/${c.id}`);
    }
    await openProfile(page);
    await expect(section(page, "certifications").getByText("No entries yet.")).toBeVisible();

    const certId = await addViaUi(page, "certifications");
    await setEntryField(page, "certifications", certId, "title", "CKA");
    await page.reload();
    await expect(entryById(page, "certifications", certId).getByRole("textbox", { name: "Certification" })).toHaveValue(
      "CKA",
    );
    await deleteEntry(page, "certifications", certId);

    // After the final delete the section is empty again and "+ Add" still works.
    await page.reload();
    await expect(section(page, "certifications").getByText("No entries yet.")).toBeVisible();
    const reAdded = await addViaUi(page, "certifications");
    await expect(entryById(page, "certifications", reAdded)).toBeVisible();
    await deleteEntry(page, "certifications", reAdded);
  });

  test("duplicate skill through the UI: the dialog names the existing entry and nothing is created", async ({
    page,
    request,
  }) => {
    await openProfile(page);

    // Remove stale "New skill" rows from earlier runs so the first add below
    // deterministically creates (201) and the second one collides (409).
    const stale = (await sectionEntries(request, "skills")).filter((s) => s.name === "New skill");
    for (const s of stale) {
      await request.delete(`${BASE_URL}/api/profile/entries/skills/${s.id}`);
    }
    const countBefore = (await sectionEntries(request, "skills")).length;

    // The first "+ Add" creates the "New skill" placeholder; a second one
    // collides on that name and must open the MergeOrKeepDialog — the
    // duplicate-skill guard reachable through the normal UI flow (FR-008).
    const firstId = await addViaUi(page, "skills");
    const dup = page.waitForResponse(
      (r) => r.url().includes("/api/profile/entries/skills") && r.request().method() === "POST" && r.status() === 409,
      { timeout: 10_000 },
    );
    await addButton(page, "skills").click();
    await dup;
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("New skill")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep existing" }).click();
    await expect(dialog).toBeHidden();

    const skillsAfter = await sectionEntries(request, "skills");
    expect(skillsAfter.filter((s) => s.name === "New skill")).toHaveLength(1);
    expect(skillsAfter).toHaveLength(countBefore + 1);
    await deleteEntry(page, "skills", firstId);
  });

  test("overlapping experience dates surface a warning without blocking the save", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/profile/entries/experience`, {
      data: { company: "Overlap Co", title: "Consultant", startDate: "2021-06", endDate: "2022-01" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { id: string; warnings: Array<{ code: string }> };
    expect(body.warnings.map((w) => w.code)).toContain("DATE_RANGE_OVERLAP");

    // Overlapping dates are a warning, not a block: the entry is stored.
    const experience = await sectionEntries(request, "experience");
    expect(experience.find((e) => e.id === body.id)).toBeTruthy();
    await request.delete(`${BASE_URL}/api/profile/entries/experience/${body.id}`);
  });

  test("a skill saved without a level stays level-less (no inference — FR-008)", async ({ page, request }) => {
    const skill = await apiPost<{ id: string }>(request, "/api/profile/entries/skills", { name: "Rust" });
    await openProfile(page);
    const entry = entryById(page, "skills", skill.id);
    // Touch another field through the editor (the level field left untouched).
    await setEntryField(page, "skills", skill.id, "category", "Programming");
    await page.reload();
    await expect(entry.getByRole("textbox", { name: "Level (user-stated)" })).toHaveValue("");
    const stored = (await sectionEntries(request, "skills")).find((s) => s.id === skill.id);
    expect(stored?.level ?? null).toBeNull();
    await deleteEntry(page, "skills", skill.id);
  });
});
