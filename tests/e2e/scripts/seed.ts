/**
 * Playwright globalSetup (specs/004-profile-editing-e2e, research R3): seed the
 * isolated environment through the app's own routes — the same ones the editor
 * uses — so seeding doubles as route-level regression coverage and needs no AI
 * key. The one fixture unreachable through the editor (a `user_entered`
 * experience row carrying a reviewFlag → INCONSISTENT_STATE from claim
 * validation, src/lib/validation/claims.ts) is written with a single direct
 * `pg` UPDATE, applied LAST so it cannot pollute earlier scenarios.
 *
 * Any non-2xx during seeding fails setup loudly: fixture drift surfaces here,
 * never mid-scenario.
 */
import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { assertE2eDatabaseUrl } from "../support/env";
import {
  BASICS,
  CERTIFICATIONS,
  DUPLICATE_SKILL_NAME,
  EDUCATION,
  EXPERIENCE,
  INCONSISTENT_TARGET,
  LANGUAGES,
  PROJECTS,
  SKILLS,
  type SeedState,
} from "../fixtures/profile";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e";
const AUTH_STATE_PATH = path.join(process.cwd(), "tests", "e2e", ".auth-state.json");

// specs/008: the app is account-gated — seeding runs as this dedicated account
// (registered first, then every seed call carries its session cookie).
const SEED_EMAIL = "e2e@example.com";
const SEED_PASSWORD = "password-123";

type Json = Record<string, unknown> & { version?: number; id?: string };

let sessionToken: string | null = null;

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json | null }> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { Cookie: `pf_session=${sessionToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Json | null;
  return { status: res.status, json };
}

/** Registers (or logs in) the dedicated seed account and captures its session cookie. */
async function signInSeedUser(): Promise<{ userId: string }> {
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: SEED_EMAIL, password: SEED_PASSWORD }),
  });
  if (registerRes.status === 201) {
    const cookie = registerRes.headers.getSetCookie().find((c) => c.startsWith("pf_session="));
    sessionToken = cookie?.split(";")[0].split("=")[1] ?? null;
    const body = (await registerRes.json()) as { user?: { id?: string } };
    return { userId: body.user?.id as string };
  }
  if (registerRes.status === 409) {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SEED_EMAIL, password: SEED_PASSWORD }),
    });
    if (loginRes.status !== 200) {
      throw new Error(`Seed login failed (${loginRes.status}) — reset the e2e database.`);
    }
    const cookie = loginRes.headers.getSetCookie().find((c) => c.startsWith("pf_session="));
    sessionToken = cookie?.split(";")[0].split("=")[1] ?? null;
    const body = (await loginRes.json()) as { user?: { id?: string } };
    return { userId: body.user?.id as string };
  }
  throw new Error(`Seed registration failed (${registerRes.status}): ${await registerRes.text()}`);
}

function expectOk(step: string, result: { status: number; json: Json | null }, expected: number, version?: number) {
  if (result.status !== expected) {
    throw new Error(`Seed step "${step}" returned ${result.status} (expected ${expected}): ${JSON.stringify(result.json)}`);
  }
  if (version !== undefined && result.json?.version !== version) {
    throw new Error(`Seed step "${step}" version ${String(result.json?.version)} ≠ expected ${version}`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  assertE2eDatabaseUrl(E2E_DATABASE_URL); // FR-001: before ANY connection
  // Wait for the webServer to answer before seeding (Playwright started it).
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const probe = await fetch(`${BASE_URL}/api/auth/session`);
      if (probe.status === 401 || probe.ok) break; // app is up and answering
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const { userId } = await signInSeedUser();

  // Normalize the profile row deterministically BEFORE any HTTP request:
  // `next build` (the webServer command) executes the /api/profile GET handler
  // at build time (cacheComponents route collection), and its parallel workers
  // race getOrCreateProfile's unordered findFirst — creating extra rows whose
  // mere presence makes every later findFirst non-deterministic. [Product
  // finding, slice 1; harness-side fix per FR-014.] This also serves as the
  // FR-001 runtime guard: if the server under test is NOT backed by the e2e
  // database (e.g. a reused dev server), the canonical-row assertion below
  // aborts the run instead of letting the suite mutate a foreign database.
  const normalize = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await normalize.connect();
  let canonicalId: string;
  try {
    await normalize.query("BEGIN");
    // FK-safe order (entries reference Profile; bullets reference entries).
    await normalize.query('DELETE FROM "ProfileSnapshot"');
    await normalize.query('DELETE FROM "Bullet"');
    await normalize.query('DELETE FROM "Experience"');
    await normalize.query('DELETE FROM "Education"');
    await normalize.query('DELETE FROM "Skill"');
    await normalize.query('DELETE FROM "LanguageSkill"');
    await normalize.query('DELETE FROM "Project"');
    await normalize.query('DELETE FROM "Certification"');
    await normalize.query('DELETE FROM "Profile"');
    canonicalId = cryptoRandomUUID();
    await normalize.query(
      `INSERT INTO "Profile" (id, "userId", version, language, "createdAt", "updatedAt")
       VALUES ($1, $2, 1, 'en', now(), now())`,
      [canonicalId, userId],
    );
    await normalize.query("COMMIT");
  } catch (err) {
    await normalize.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await normalize.end();
  }

  // FR-001 runtime guard: the server under test must serve exactly the
  // canonical row — anything else means it is pointed at another database.
  const sanity = await api("GET", "/api/profile");
  const sanityProfile = sanity.json?.profile as { id: string; version: number } | undefined;
  if (sanity.status !== 200 || sanityProfile?.id !== canonicalId || sanityProfile?.version !== 1) {
    throw new Error(
      `The server under test (${BASE_URL}) is not backed by the e2e database ` +
        `(saw profile ${sanityProfile?.id ?? "?"} v${sanityProfile?.version ?? "?"}, expected ${canonicalId} v1). ` +
        "Refusing to run — the suite would mutate a foreign database.",
    );
  }

  const state: SeedState = {
    profileVersionAfterSeed: 0,
    entryIds: { experience: [], education: [], skills: [], languages: [], projects: [], certifications: [] },
    inconsistent: { entryId: "", bulletId: "" },
    duplicateSkillName: DUPLICATE_SKILL_NAME,
    generation: { analysisId: "", jobId: "", documentId: "", omittedExperienceId: "" },
    queuedGeneration: { analysisId: "", jobId: "" },
    legacy: { analysisId: "" },
  };

  // Baseline profile exists (getOrCreateProfile creates v1 on first read).
  const initial = await api("GET", "/api/profile");
  expectOk("initial read", initial, 200);
  let version: number = (initial.json?.profile as { version: number }).version;

  // Basics + language (one mutation).
  const basics = await api("PATCH", "/api/profile", { basics: { ...BASICS, links: [] }, language: "en" });
  expectOk("basics", basics, 200, version + 1);
  version += 1;

  const post = async (section: string, body: Record<string, unknown>): Promise<string> => {
    const res = await api("POST", `/api/profile/entries/${section}`, body);
    expectOk(`create ${section}`, res, 201, version + 1);
    version += 1;
    return res.json?.id as string;
  };

  // Sections in a fixed order; bullets ride along on the create payloads.
  for (const entry of EXPERIENCE) {
    const id = await post("experience", {
      ...entry,
      bullets: entry.bullets.map((text, order) => ({ text, order })),
    });
    state.entryIds.experience.push(id);
  }
  for (const entry of EDUCATION) state.entryIds.education.push(await post("education", { ...entry }));
  for (const entry of SKILLS) state.entryIds.skills.push(await post("skills", { ...entry, aliases: [] }));
  for (const entry of LANGUAGES) state.entryIds.languages.push(await post("languages", { ...entry }));
  for (const entry of PROJECTS) {
    state.entryIds.projects.push(
      await post("projects", { ...entry, bullets: entry.bullets.map((text, order) => ({ text, order })) }),
    );
  }
  for (const entry of CERTIFICATIONS) state.entryIds.certifications.push(await post("certifications", { ...entry }));

  state.profileVersionAfterSeed = version;

  // The one editor-unreachable fixture, applied LAST (research R3): a
  // `user_entered` experience row carrying a reviewFlag → INCONSISTENT_STATE.
  const targetEntryId = state.entryIds.experience[INCONSISTENT_TARGET.experienceIndex]!;
  const profileBody = (await api("GET", "/api/profile")).json?.profile as {
    experience: Array<{ id: string; bullets?: Array<{ id: string }> }>;
  };
  const targetExperience = profileBody.experience.find((e) => e.id === targetEntryId);
  const targetBullet = targetExperience?.bullets?.[INCONSISTENT_TARGET.bulletIndex] ?? null;
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query('UPDATE "Experience" SET "reviewFlag" = $1 WHERE "id" = $2', [
      "containment_failed",
      targetEntryId,
    ]);
  } finally {
    await client.end();
  }
  state.inconsistent = { entryId: targetEntryId, bulletId: targetBullet?.id ?? "" };

  // Feature-005 fixture (direct DB, applied after the profile fixtures): a
  // matched analysis + succeeded generation whose version carries a rewritten
  // title, a SelectionRecord with evidence, and one `selection` omission — the
  // generation views (SelectionView / OmissionsList / settings controls) render
  // end-to-end without an AI key (the deliverable is seeded, not generated).
  const bulletIds = (profileBody.experience.find((e) => e.id === state.entryIds.experience[0])?.bullets ?? []).map(
    (b) => b.id,
  );
  const firstExpId = state.entryIds.experience[0]!;
  const omittedExpId = state.entryIds.experience[2]!;
  const kubeSkillId = state.entryIds.skills[0]!;
  const analysisId = cryptoRandomUUID();
  const documentId = cryptoRandomUUID();
  const jobId = cryptoRandomUUID();
  const versionId = cryptoRandomUUID();
  const matchReport = {
    overallScore: 75,
    scoreBreakdown: {
      hardRequirementsMet: 1,
      preferredRequirementsMet: 0,
      exactMatches: 1,
      aliasMatches: 0,
      semanticMatches: 0,
      hardWeight: 60,
      preferredWeight: 30,
      evidenceBonus: 5,
    },
    requirements: [
      {
        id: "r-kube",
        text: "Kubernetes",
        importance: "must",
        isHardConstraint: true,
        status: "strong",
        matchMethod: "exact",
        evidence: [
          { type: "skill", id: kubeSkillId, snippet: "Kubernetes" },
          { type: "bullet", id: firstExpId, snippet: "Senior Platform Engineer — Acme Analytics" },
        ],
        note: null,
      },
    ],
    recommendedKeywords: ["Kubernetes", "Go"],
    missingKeywords: ["Rust"],
    semanticDropped: 0,
  };
  const content = {
    claimIdVersion: 1,
    summary: "Platform engineer with deep Kubernetes operations experience.",
    summaryProvenance: [{ type: "bullet", id: bulletIds[0] ?? firstExpId, snippet: "Operated Kubernetes clusters." }],
    experience: [
      {
        id: firstExpId,
        title: {
          claimId: `expTitle.${firstExpId}`,
          text: "Senior Platform Engineer — Kubernetes focus",
          sourceTitle: "Senior Platform Engineer",
        },
        bullets: [
          {
            claimId: `exp.${firstExpId}.1`,
            text: "Operated Kubernetes clusters serving 2M requests per day.",
            sourceBulletIds: [bulletIds[0] ?? firstExpId],
          },
        ],
      },
    ],
    education: [
      {
        id: state.entryIds.education[0]!,
        claimId: `edu.${state.entryIds.education[0]}`,
        text: "BSc · Computer Science · McGill University",
        sourceIds: [state.entryIds.education[0]!],
      },
    ],
    projects: [],
    certifications: [],
    skills: ["Kubernetes"],
    omissions: [{ type: "experience", id: omittedExpId, reason: "selection" }],
  };
  const selection = {
    included: [
      {
        entryId: firstExpId,
        kind: "experience",
        rank: 1,
        score: 0.812,
        basis: {
          evidenceRefs: [
            { type: "skill", id: kubeSkillId, snippet: "Kubernetes" },
            { type: "bullet", id: firstExpId, snippet: "Senior Platform Engineer — Acme Analytics" },
          ],
          methodCredits: ["exact"],
          recency: 1,
        },
      },
    ],
    generatedAt: new Date().toISOString(),
  };
  const validationReport = {
    // warnings-only report (Fact Guard removed): a draft fallback warning the
    // UI renders passively
    flags: [
      {
        code: "VERBATIM_FALLBACK",
        claim: `exp.${firstExpId}.2`,
        severity: "warning",
        resolution: "pending",
      },
    ],
    summary: { blockers: 0, warnings: 1 },
  };
  const extractionCheck = {
    passed: true,
    pages: 1,
    level1: { passed: true, elements: [] },
    level2: { passed: true, threshold: 0.95, blocks: [] },
  };
  const gen = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await gen.connect();
  try {
    await gen.query('INSERT INTO "JobAnalysis" (id, "userId", "jdText", language, status, "profileVersion", "matchReport", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())', [
      analysisId,
      userId,
      "Senior Platform Engineer. Must have Kubernetes experience. Nice to have: Go.",
      "en",
      "matched",
      version,
      JSON.stringify(matchReport),
    ]);
    await gen.query('INSERT INTO "GeneratedDocument" (id, "analysisId", kind, "createdAt", "updatedAt") VALUES ($1,$2,$3,now(),now())', [
      documentId,
      analysisId,
      "cv",
    ]);
    await gen.query(
      'INSERT INTO "GenerationJob" (id, "analysisId", kind, settings, status, attempt, "profileVersion", "runId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,1,$6,$7,now(),now())',
      [
        jobId,
        analysisId,
        "cv",
        JSON.stringify({ outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 60, templateId: "ats" }),
        "succeeded",
        version,
        cryptoRandomUUID(),
      ],
    );
    await gen.query(
      'INSERT INTO "GeneratedDocumentVersion" (id, "documentId", version, "producingJobId", content, selection, "validationReport", revision, artifacts, "extractionCheck", "createdAt", "updatedAt") VALUES ($1,$2,1,$3,$4,$5,$6,0,$7,$8,now(),now())',
      [versionId, documentId, jobId, JSON.stringify(content), JSON.stringify(selection), JSON.stringify(validationReport), "[]", JSON.stringify(extractionCheck)],
    );
    // feature 006 US3 fixture: a second analysis whose job is still queued —
    // the progress-indicator state (gen-progress visible, controls disabled
    // with reason) renders from this without an AI key.
    const queuedAnalysisId = cryptoRandomUUID();
    const queuedJobId = cryptoRandomUUID();
    await gen.query(
      'INSERT INTO "JobAnalysis" (id, "userId", "jdText", language, status, "profileVersion", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now(),now())',
      [
        queuedAnalysisId,
        userId,
        "Senior Platform Engineer. Must have Kubernetes experience. Nice to have: Go.",
        "en",
        "matched",
        version,
      ],
    );
    await gen.query(
      'INSERT INTO "GenerationJob" (id, "analysisId", kind, settings, status, attempt, "profileVersion", "runId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,1,$6,$7,now(),now())',
      [
        queuedJobId,
        queuedAnalysisId,
        "cv",
        JSON.stringify({ outputLanguage: "en", pageBudget: 2, tone: "professional", summaryMaxWords: 60, templateId: "ats" }),
        "queued",
        version,
        cryptoRandomUUID(),
      ],
    );
    // specs/008 US4 fixture: a quarantined (owner-less) analysis — invisible to
    // every account until scripts/assign-owner.ts claims it for the seed user.
    const legacyAnalysisId = cryptoRandomUUID();
    await gen.query(
      'INSERT INTO "JobAnalysis" (id, "jdText", language, status, "profileVersion", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())',
      [legacyAnalysisId, "LEGACY-CLAIM-PROBE: pre-multi-user analysis", "en", "created", 1],
    );
    state.generation = { analysisId, jobId, documentId, omittedExperienceId: omittedExpId };
    state.queuedGeneration = { analysisId: queuedAnalysisId, jobId: queuedJobId };
    state.legacy = { analysisId: legacyAnalysisId };
  } finally {
    await gen.end();
  }

  await writeFile(path.join(process.cwd(), "tests", "e2e", ".seed-state.json"), JSON.stringify(state, null, 2));
  // specs/008: storage state so specs 01–10 (seeded, authed flows) share the
  // seed account's session for BOTH the page and request fixtures.
  await writeFile(
    AUTH_STATE_PATH,
    JSON.stringify(
      {
        cookies: [
          {
            name: "pf_session",
            value: sessionToken,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
            // Playwright requires fully-typed cookie fields (float expiry, boolean secure).
            expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            secure: false,
          },
        ],
        origins: [],
      },
      null,
      2,
    ),
  );
  console.log(`✓ seeded profile at version ${version} (inconsistent fixture on experience ${targetEntryId})`);
  console.log(`✓ seeded matched analysis + succeeded generation for the feature-005 views (job ${jobId})`);
  return async () => {};
}
