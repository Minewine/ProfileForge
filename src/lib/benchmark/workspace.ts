import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { hashPassword } from "@/lib/auth/password";
import { BenchmarkFatalError } from "@/lib/benchmark/config";
import { assertBenchmarkUrl, BENCHMARK_DB_NAME } from "@/lib/benchmark/env";
import { db } from "@/lib/db";

// The pure environment guard lives in env.ts (no DB imports) so the CLI entry
// can apply it before any app module — and the Prisma client — is loaded.
export {
  applyBenchmarkEnvironment,
  assertBenchmarkUrl,
  BENCHMARK_DB_NAME,
  BENCHMARK_UPLOADS_DIR,
  resolveBenchmarkDatabaseUrl,
} from "@/lib/benchmark/env";

/** DROP/CREATE the public schema, then apply migrations — benchmark DB only.
 *  Creates the database first if it does not exist (fresh compose volume). */
export async function resetBenchmarkSchema(url: string): Promise<void> {
  assertBenchmarkUrl(url);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${BENCHMARK_DB_NAME}`);
  } catch (err) {
    if ((err as { code?: string }).code !== "42P04") {
      // 42P04 = duplicate_database — anything else is a real failure
      throw new BenchmarkFatalError(3, `Could not create the benchmark database: ${String(err)}`);
    }
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  if (result.status !== 0) {
    throw new BenchmarkFatalError(3, "prisma migrate deploy failed against the benchmark database.");
  }
}

/** A fresh synthetic user per run (research D2): owner of every row the run
 *  creates; can never log in (random password, no session is ever issued). */
export async function createRunUser(): Promise<{ id: string; email: string }> {
  const email = `bench-${randomUUID()}@benchmark.local`;
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword(randomUUID()) },
  });
  return { id: user.id, email };
}
