#!/usr/bin/env node
/**
 * Test-setup helper for specs/008 T042 (spec 08's queued-generation view):
 * the stale-running recovery (research R4) correctly fails `queued` jobs older
 * than 60s, and specs 01–07 run before 08 — so the seeded queued job needs its
 * timestamps refreshed to represent "just queued" when the view test runs.
 * Talks ONLY to the dedicated e2e database (same abort guard as reset-db.mjs).
 */
import { Client } from "pg";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://profileforge:profileforge@localhost:5434/profileforge_e2e";

function abort(reason) {
  console.error(`\n✋ touch-queued-job ABORTED before any mutation: ${reason}`);
  process.exit(1);
}

// Same guard spirit as reset-db.mjs: every mutation targets the e2e database
// ONLY. (Callers may point DATABASE_URL at the e2e URL too, as spec 13 does.)
if (!E2E_DATABASE_URL.includes("profileforge_e2e")) {
  abort(`the e2e DATABASE_URL must target profileforge_e2e.`);
}

const jobId = process.argv[2];
if (!jobId) abort(`usage: node touch-queued-job.mjs <generationJobId>`);

const client = new Client({ connectionString: E2E_DATABASE_URL });
await client.connect();
try {
  const result = await client.query(
    `UPDATE "GenerationJob" SET status = 'queued', "cancelRequested" = false, "createdAt" = now(), "updatedAt" = now() WHERE id = $1`,
    [jobId],
  );
  if (result.rowCount !== 1) abort(`generation job ${jobId} not found in the e2e database.`);
  console.log(`queued job ${jobId} refreshed`);
} finally {
  await client.end();
}
