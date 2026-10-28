
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import pg from "pg";
import { entryById, openProfile, saveStatus, setEntryField } from "./support/editor";
import { BASE_URL, apiGet, apiPost, assertE2eDatabaseUrl } from "./support/env";

type ClaimsBody = {
  flags: Array<{ code: string; claim: string; severity: string; affectedFieldIds: string[] }>;
  summary: { blockers: number; warnings: number };
};

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e";
assertE2eDatabaseUrl(E2E_DATABASE_URL);

test.describe("US6 — provenance and fact-guard honesty", () => {
  test("editor-created entries are user-entered and stay attributed through edits", async ({ page, request }) => {
    // "+ Add" now works in every section (spec 007 FR-006) — languages included.
    const lang = await apiPost<{ id: string }>(request, "/api/profile/entries/languages", { name: "German" });
    await openProfile(page);
    const entry = entryById(page, "languages", lang.id!);
    await expect(entry.getByText("user-entered", { exact: true })).toBeVisible();

    // Editing through the editor keeps the attribution (never blank/imported).
    await setEntryField(page, "languages", lang.id!, "proficiency", "Conversational");
    await page.reload();
    await expect(entryById(page, "languages", lang.id!).getByText("user-entered", { exact: true })).toBeVisible();
  });

  test("claim validation is honest: clean content has zero blockers; the inconsistent fixture surfaces by code", async ({
    page,
    request,
  }) => {
    // The inconsistent fixture (an experience row carrying a reviewFlag on
    // user_entered provenance — editor-unreachable) is applied by the seed,
    // but an earlier spec's version restore legitimately reverts it; re-apply
    // it here (the same single direct-DB write) and undo it after.
    const setFlag = async (value: string | null) => {
      // Match on company, not the seeded entry id: an earlier spec's version
      // restore reinserts all entries with NEW ids (repository delete+recreate).
      const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
      await client.connect();
      try {
        await client.query('UPDATE "Experience" SET "reviewFlag" = $1 WHERE company = $2', [
          value,
          "Acme Analytics",
        ]);
      } finally {
        await client.end();
      }
    };
    await setFlag("containment_failed");

    await openProfile(page);
    await page.getByTestId("validate-claims").click();
    await expect(page.getByText("INCONSISTENT_STATE", { exact: true })).toBeVisible();
    await expect(page.getByText("0 blockers")).toBeVisible();

    const report = await apiPost<ClaimsBody>(request, "/api/validation/claims");
    expect(report.summary.blockers).toBe(0);
    expect(report.summary.warnings).toBe(1);
    expect(report.flags).toHaveLength(1);
    expect(report.flags[0].code).toBe("INCONSISTENT_STATE");
    expect(report.flags[0].severity).toBe("warning");

    // Well-formed seeded content produces no grounding blockers of any kind.
    const codes = report.flags.map((f) => f.code);
    expect(codes).not.toContain("DANGLING_PROVENANCE");
    expect(codes).not.toContain("MISSING_LOCATOR");
    expect(codes).not.toContain("CONTAINMENT_UNRESOLVED");

    await setFlag(null); // leave the environment clean
  });

  test("a confirmed entry stays editable: field edits save and keep user-confirmed attribution (FR-003)", async ({
    page,
    request,
  }) => {
    // Imported entries only come from the import path — seed one directly.
    const profile = await apiGet<{ profile: { id: string } }>(request, "/api/profile");
    const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    let skillId = "";
    try {
      const docId = `doc-e2e-${Date.now()}`;
      await client.query(
        `INSERT INTO "SourceDocument" (id, "originalFilename", "storagePath", "sha256", "mimeType",
           "sizeBytes", "detectedLanguage", "extractedPages", "parseStatus", "updatedAt")
         VALUES ($1, 'e2e.pdf', '/tmp/e2e.pdf', $2, 'application/pdf', 1, 'en', '[]'::jsonb, 'parsed', now())`,
        [docId, `e2e-${Date.now()}`],
      );
      skillId = (
        await client.query<{ id: string }>(
          `INSERT INTO "Skill" (id, "profileId", name, provenance, "sourceDocumentId", "sourceLocator",
             confidence, "reviewFlag", "order")
           VALUES ($1, $2, 'PostgreSQL', 'imported', $3, $4::jsonb, 0.4, 'low_confidence', 99)
           RETURNING id`,
          [`skill-e2e-${Date.now()}`, profile.profile.id, docId, JSON.stringify({ page: 3 })],
        )
      ).rows[0].id;
    } finally {
      await client.end();
    }

    await openProfile(page);
    const entry = entryById(page, "skills", skillId);
    await expect(entry.getByText("imported · p.3", { exact: true })).toBeVisible();
    await entry.getByRole("button", { name: "Confirm" }).click();
    await page.waitForResponse(
      (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout: 10_000 },
    );
    await expect(entry.getByText("user-confirmed", { exact: true })).toBeVisible();

    // The confirmed entry must remain editable, with attribution intact.
    await setEntryField(page, "skills", skillId, "name", "PostgreSQL Pro");
    await expect(saveStatus(page)).toContainText("Saved · v");
    await page.reload();
    const reloaded = entryById(page, "skills", skillId);
    await expect(reloaded.getByText("user-confirmed", { exact: true })).toBeVisible();
    await expect(reloaded.getByRole("textbox", { name: "Name" })).toHaveValue("PostgreSQL Pro");

    await request.delete(`${BASE_URL}/api/profile/entries/skills/${skillId}`);
  });
});
