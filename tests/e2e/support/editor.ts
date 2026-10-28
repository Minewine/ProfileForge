/**
 * Profile-editor page objects (specs/004-profile-editing-e2e,
 * contracts/e2e-suite.md selector contract). Waits for autosave at the network
 * level — never with fixed sleeps (the debounce is 800 ms per field, research
 * R6.4). Bullet ids are stable across saves since spec 007 (id-preserving
 * bullet sync), but specs still assert on bullet text/order, never ids.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { BASE_URL, type SectionName } from "./env";

export function section(page: Page, name: SectionName): Locator {
  return page.getByTestId(`section-${name}`);
}

export function addButton(page: Page, name: SectionName): Locator {
  return page.getByTestId(`add-${name}`);
}

/** The seeded/created entry container by its stable id. */
export function entryById(page: Page, name: SectionName, entryId: string): Locator {
  return page.getByTestId(`entry-${name}-${entryId}`);
}

/** A labeled per-entry field (T007 wiring: entry-{section}-{entryId}-{field}). */
export function entryField(page: Page, name: SectionName, entryId: string, field: string): Locator {
  return page.locator(`#entry-${name}-${entryId}-${field}`);
}

/** The i-th entry of a section in DOM order (position-based lookups for
 *  scenarios that create entries and read ids back via the API). */
export function entryAt(page: Page, name: SectionName, index: number): Locator {
  return section(page, name).locator(`[data-testid^="entry-${name}-"]`).nth(index);
}

/** Set a field and wait for its debounced PATCH to land (network, not sleep). */
export async function setEntryField(
  page: Page,
  name: SectionName,
  entryId: string,
  field: string,
  value: string,
): Promise<void> {
  const fieldLocator = entryField(page, name, entryId, field);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
    { timeout: 10_000 },
  );
  await fieldLocator.fill(value);
  await saved;
}

/** Resolve the entry id the UI currently shows at a DOM position (via testid). */
export async function entryIdAt(page: Page, name: SectionName, index: number): Promise<string> {
  const testId = await entryAt(page, name, index).getAttribute("data-testid");
  return testId!.replace(`entry-${name}-`, "");
}

/** The bullet textareas inside an entry (assert on text/order, not ids). */
export function bulletTextareas(entry: Locator): Locator {
  return entry.locator("textarea");
}

export async function addBullet(entry: Locator, text: string, page: Page): Promise<void> {
  // "+ Bullet" adds a local draft with no request (spec 007: empty bullets are
  // never sent) — the PATCH fires once the text is typed.
  await entry.getByRole("button", { name: "+ Bullet" }).click();
  const savedText = page.waitForResponse(
    (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
    { timeout: 10_000 },
  );
  await bulletTextareas(entry).last().fill(text);
  await savedText;
}

export async function removeBullet(entry: Locator, index: number, page: Page): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
    { timeout: 10_000 },
  );
  await entry.getByLabel("Remove bullet").nth(index).click();
  await saved;
}

export async function deleteEntry(page: Page, name: SectionName, entryId: string): Promise<void> {
  // Deletes navigate through confirm() in some builds — accept it either way.
  page.once("dialog", (dialog) => void dialog.accept());
  const deleted = page.waitForResponse(
    (r) => r.url().includes(`/api/profile/entries/${name}/`) && r.request().method() === "DELETE",
    { timeout: 10_000 },
  );
  await entryById(page, name, entryId).getByRole("button", { name: "Delete" }).click();
  await deleted;
}

export function saveStatus(page: Page): Locator {
  return page.getByTestId("save-status");
}

export function versionRows(page: Page): Locator {
  return page.getByTestId("version-row");
}

/** Generic wait for any successful profile PATCH (basics path included). */
export function waitForAutosave(page: Page, timeout = 10_000): Promise<void> {
  return page
    .waitForResponse(
      (r) => r.url().includes("/api/profile") && r.request().method() === "PATCH" && r.status() === 200,
      { timeout },
    )
    .then(() => undefined);
}

/** Load the profile page and wait past `Loading…`. */
export async function openProfile(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/profile`);
  await expect(page.getByRole("heading", { name: "Profile editor" })).toBeVisible();
}
