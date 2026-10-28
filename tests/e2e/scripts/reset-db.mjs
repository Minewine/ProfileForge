#!/usr/bin/env node
/**
 * E2E environment reset (specs/004-profile-editing-e2e, research R2 / FR-001).
 * Talks ONLY to the dedicated e2e database: any resolved URL that does not
 * contain `profileforge_e2e` aborts before any mutation — the suite must never
 * be able to touch the developer's main database, even misconfigured.
 *
 * Steps: ensure the `e2e-db` compose service is healthy → DROP/CREATE the
 * public schema → `prisma migrate deploy` against the e2e URL → print the MAIN
 * database's Profile.version + table counts (the SC-004 untouched-baseline).
 */
import { spawnSync } from "node:child_process";
import pg from "pg";

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e";
const MAIN_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://profileforge:profileforge@localhost:5433/profileforge";

function abort(reason) {
  console.error(`\n✋ E2E reset ABORTED before any mutation: ${reason}`);
  console.error(`   resolved e2e URL: ${E2E_DATABASE_URL}`);
  process.exit(1);
}

// FR-001 abort guard — check BEFORE anything touches a database.
if (!E2E_DATABASE_URL.includes("profileforge_e2e")) {
  abort(`the e2e DATABASE_URL must target profileforge_e2e.`);
}
if (MAIN_DATABASE_URL.includes("profileforge_e2e")) {
  abort(`DATABASE_URL (main) must NOT point at the e2e database.`);
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`✋ command failed (${command} ${args.join(" ")}) — exiting.`);
    process.exit(result.status ?? 1);
  }
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

console.log("• ensuring the e2e-db compose service is up…");
run("docker", ["compose", "up", "-d", "e2e-db", "--wait"]);

console.log("• resetting the e2e schema (DROP SCHEMA public CASCADE)…");
await withClient(E2E_DATABASE_URL, async (client) => {
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
});

console.log("• applying migrations (prisma migrate deploy → e2e DB only)…");
run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: E2E_DATABASE_URL });

// SC-004 baseline: snapshot the MAIN database state so a full run can prove it
// was untouched. Read-only; never writes.
const baseline = await withClient(MAIN_DATABASE_URL, async (client) => {
  const profile = await client.query('SELECT version FROM "Profile" ORDER BY "updatedAt" DESC LIMIT 1');
  const tables = ["Experience", "Education", "Skill", "LanguageSkill", "Project", "Certification", "Bullet"];
  const counts = {};
  for (const table of tables) {
    const count = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
    counts[table] = count.rows[0].n;
  }
  return { profileVersion: profile.rows[0]?.version ?? null, counts };
});
console.log("• MAIN database baseline (must be identical after the run — SC-004):");
console.log(`  Profile.version = ${baseline.profileVersion}`);
console.log(`  ${JSON.stringify(baseline.counts)}`);

console.log("✓ e2e database reset complete.");
