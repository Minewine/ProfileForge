
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// specs/008: seeded flows run as the seed account (session cookie for page + request fixtures).
test.use({ storageState: "tests/e2e/.auth-state.json" });
import { apiGet, type SeedStateFile } from "./support/env";

const seedState: SeedStateFile = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests", "e2e", ".seed-state.json"), "utf8"),
);

/**
 * Feature 005 — the generation views on the seeded deliverable (matched
 * analysis + succeeded generation, seeded by globalSetup: the suite runs the
 * production build with no AI key, so the version rows are seeded directly and
 * the spec covers everything the UI renders from them): the SelectionView with
 * rank/score/evidence, the omissions list distinguishing `selection`, the new
 * settings controls (summary length, template, DE output), and the rewritten
 * title served by the document API.
 */
test.describe("Feature 005 — selection & rewriting views", () => {
  test("selection view shows rank, score, and evidence links; omissions distinguish selection; new controls present", async ({
    page,
    request,
  }) => {
    const { generation } = seedState;
    await page.goto(`/jobs/${generation.analysisId}`);

    // The panel resumed the seeded generation (latest job for the analysis).
    await expect(page.getByText("Version 1", { exact: true })).toBeVisible();

    // SelectionView: rank chip, score, method credit, recency, evidence snippet.
    await expect(page.getByText(/Selection \(1 entries\)/)).toBeVisible();
    const selectionRow = page.locator("li", { hasText: "#1 Experience" });
    await expect(selectionRow).toBeVisible();
    await expect(selectionRow.getByText("score 0.812")).toBeVisible();
    await expect(selectionRow.getByText("exact", { exact: true })).toBeVisible(); // method-credit badge
    await expect(selectionRow.getByText("recency 100%", { exact: true })).toBeVisible();
    // the evidence link resolves through the match report's evidence map
    await expect(
      page.getByText("Senior Platform Engineer — Acme Analytics").first(),
    ).toBeVisible();

    // OmissionsList: the seeded selection omission with its reason badge + restore.
    await expect(page.getByText("selection", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();

    // Feature 006 US2 — blocked exports explain themselves: the gate block names
    // the blocker count and the unlock action, and the flag row carries the
    // one-sentence NUMERIC_MISMATCH explanation beside its code.
    await expect(page.getByText("Claims need review first")).toBeVisible();
    const gateBlock = page.locator("div", { hasText: "Claims need review first" }).filter({ hasText: "Downloads unlock" });
    await expect(gateBlock.first()).toBeVisible();
    await expect(gateBlock.first()).toContainText("1 claim");
    await expect(
      page.getByText("A number in this claim doesn't match your profile evidence — fix it or confirm the correct figure."),
    ).toBeVisible();
    await expect(page.getByText("NUMERIC_MISMATCH", { exact: true })).toBeVisible();

    // Feature-005 settings controls render: summary length, template, DE output.
    await expect(page.getByLabel("Summary length (CV)")).toBeVisible();
    await expect(page.getByLabel("Summary length (CV)")).toContainText("≤ 60 words");
    const template = page.getByLabel("Template (CV)");
    await expect(template).toHaveValue("ats"); // ATS stays the default
    await expect(template.getByRole("option", { name: "Designed — two column" })).toBeAttached();
    await expect(page.getByRole("option", { name: "Deutsch" })).toBeAttached();

    // API cross-check: the served version carries the rewritten title, the
    // selection record, and the distinguishable omission.
    const doc = await apiGet<{
      content: {
        experience: Array<{ title?: { claimId: string; text: string; sourceTitle: string } }>;
      };
      selection: { included: Array<{ rank: number; kind: string }> };
      omissions: Array<{ type: string; id: string; reason: string }>;
    }>(request, `/api/generations/${generation.jobId}/document`);
    expect(doc.content.experience[0]!.title).toMatchObject({
      text: "Senior Platform Engineer — Kubernetes focus",
      sourceTitle: "Senior Platform Engineer",
    });
    expect(doc.selection.included).toEqual([expect.objectContaining({ rank: 1, kind: "experience" })]);
    expect(doc.omissions).toEqual([
      { type: "experience", id: generation.omittedExperienceId, reason: "selection" },
    ]);
  });

  test("a queued generation shows the progress indicator and disabled-with-reason controls (feature 006 US3)", async ({
    page,
  }) => {
    const { queuedGeneration } = seedState;
    // Setup (specs/008 T042 adaptation, assertions unchanged): stale-running
    // recovery correctly fails queued jobs older than 60s, and specs 01–07 run
    // first — refresh the fixture so it represents "just queued" (e2e DB only).
    execSync(`node tests/e2e/scripts/touch-queued-job.mjs ${queuedGeneration.jobId}`, {
      stdio: "inherit",
    });
    await page.goto(`/jobs/${queuedGeneration.analysisId}`);
    await expect(page.getByText("queued", { exact: true })).toBeVisible();

    // the persistent progress indicator rides the status badge while queued…
    await expect(page.getByTestId("gen-progress")).toBeVisible();

    // …and the generate controls state WHY they are disabled (the CV button
    // reads "Generating…" while the job is active).
    const generate = page.getByRole("button", { name: "Generating…" });
    await expect(generate).toBeDisabled();
    await expect(generate).toHaveAttribute("title", "Generation in progress");

    // terminal-state regression: the succeeded job's panel has no indicator.
    await page.goto(`/jobs/${seedState.generation.analysisId}`);
    await expect(page.getByTestId("gen-progress")).toHaveCount(0);
  });
});
