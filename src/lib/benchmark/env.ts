import { mkdirSync } from "node:fs";
import { BenchmarkFatalError } from "@/lib/benchmark/config";

export const BENCHMARK_DB_NAME = "profileforge_benchmark";
export const BENCHMARK_UPLOADS_DIR = "./uploads-benchmark";

/**
 * Dependency-free environment guard. Lives apart from workspace.ts (which
 * imports the app's DB module) so the CLI entry can apply it BEFORE any app
 * module — and therefore the Prisma client — is loaded.
 */

/** Derive the benchmark database URL: explicit BENCHMARK_DATABASE_URL wins,
 *  otherwise the DATABASE_URL with the database name swapped (same derivation
 *  as tests/global-setup.ts). */
export function resolveBenchmarkDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.BENCHMARK_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const base = env.DATABASE_URL?.trim();
  if (!base) {
    throw new BenchmarkFatalError(3, "DATABASE_URL is not set; cannot derive the benchmark database URL.");
  }
  const match = base.match(/^(.*\/)([^/?]+)(\?.*)?$/);
  if (!match) {
    throw new BenchmarkFatalError(3, `Cannot derive a benchmark database URL from "${base}".`);
  }
  return `${match[1]}${BENCHMARK_DB_NAME}${match[3] ?? ""}`;
}

/** Hard isolation guard (research D2): refuse — before any mutation — any URL
 *  that does not target the dedicated benchmark database. */
export function assertBenchmarkUrl(url: string): void {
  if (!url.includes(BENCHMARK_DB_NAME)) {
    throw new BenchmarkFatalError(
      3,
      `Benchmark refuses to run against this URL: it must target the ${BENCHMARK_DB_NAME} database.`,
    );
  }
}

/**
 * Boot-time environment switch: resolve + assert the benchmark URL, point
 * DATABASE_URL at it, and force the benchmark uploads directory.
 */
export function applyBenchmarkEnvironment(env: Record<string, string | undefined> = process.env): string {
  const url = resolveBenchmarkDatabaseUrl(env);
  assertBenchmarkUrl(url);
  env.DATABASE_URL = url;
  env.UPLOADS_DIR = BENCHMARK_UPLOADS_DIR;
  mkdirSync(BENCHMARK_UPLOADS_DIR, { recursive: true });
  return url;
}
