/**
 * Shared E2E environment helpers (specs/004-profile-editing-e2e,
 * contracts/e2e-suite.md). Spec-side API assertions go through the same
 * baseURL the browser uses.
 */
import type { APIRequestContext } from "@playwright/test";

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

export const SECTION_TITLES = {
  experience: "Experience",
  education: "Education",
  skills: "Skills",
  languages: "Languages",
  projects: "Projects",
  certifications: "Certifications",
} as const;

export type SectionName = keyof typeof SECTION_TITLES;

/** Thin GET helper for cross-checking stored state from specs. */
export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path);
  if (!res.ok()) throw new Error(`GET ${path} → ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** POST helper — returns the parsed JSON body (success payloads and error
 *  envelopes alike; callers assert on shape). */
export async function apiPost<T>(request: APIRequestContext, path: string, body?: unknown): Promise<T> {
  const res = await request.post(path, { data: body ?? {} });
  return (await res.json().catch(() => null)) as T;
}

/** PATCH helper (entry updates) — parsed JSON body. */
export async function apiPatch<T>(request: APIRequestContext, path: string, body?: unknown): Promise<T> {
  const res = await request.patch(path, { data: body ?? {} });
  return (await res.json().catch(() => null)) as T;
}

/** DELETE helper (entry removal) — parsed JSON body. */
export async function apiDelete<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.delete(path);
  return (await res.json().catch(() => null)) as T;
}

/** The seeded state written by globalSetup (tests/e2e/.seed-state.json). */
export type SeedStateFile = {
  profileVersionAfterSeed: number;
  entryIds: Record<SectionName, string[]>;
  inconsistent: { entryId: string; bulletId: string };
  duplicateSkillName: string;
  generation: {
    analysisId: string;
    jobId: string;
    documentId: string;
    omittedExperienceId: string;
  };
  /** Feature-006 US3 fixture: a second analysis with a still-queued job. */
  queuedGeneration: {
    analysisId: string;
    jobId: string;
  };
  /** specs/008 US4 fixture: a quarantined (owner-less) pre-multi-user analysis. */
  legacy: {
    analysisId: string;
  };
};

/**
 * FR-001 abort guard, shared by every harness component that opens a direct
 * database connection (reset script, seed, fixture writes): refuse any URL
 * that does not target the dedicated e2e database — `npx playwright test`
 * bypasses the npm script's reset step, so the guard must live here too, not
 * only in reset-db.mjs.
 */
export function assertE2eDatabaseUrl(url: string): void {
  if (!url.includes("profileforge_e2e")) {
    throw new Error(
      `E2E database guard: "${url}" does not target profileforge_e2e — refusing to run against a foreign database.`,
    );
  }
}
