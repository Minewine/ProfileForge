import { describe, expect, it } from "vitest";
import {
  assertBenchmarkUrl,
  createRunUser,
  resetBenchmarkSchema,
  resolveBenchmarkDatabaseUrl,
} from "@/lib/benchmark/workspace";
import { db } from "@/lib/db";

describe("benchmark workspace", () => {
  it("derives the benchmark URL by swapping the database name", () => {
    const url = resolveBenchmarkDatabaseUrl({
      DATABASE_URL: "postgresql://profileforge:pw@localhost:5433/profileforge",
    });
    expect(url).toBe("postgresql://profileforge:pw@localhost:5433/profileforge_benchmark");
  });

  it("prefers an explicit BENCHMARK_DATABASE_URL", () => {
    expect(
      resolveBenchmarkDatabaseUrl({
        DATABASE_URL: "postgresql://profileforge:pw@localhost:5433/profileforge",
        BENCHMARK_DATABASE_URL: "postgresql://other@remote/other_benchmark",
      }),
    ).toBe("postgresql://other@remote/other_benchmark");
  });

  it("refuses to target any database other than profileforge_benchmark", () => {
    for (const url of [
      "postgresql://profileforge:pw@localhost:5433/profileforge",
      "postgresql://profileforge:pw@localhost:5433/profileforge_test",
      "postgresql://profileforge:pw@localhost:5434/profileforge_e2e",
    ]) {
      expect(() => assertBenchmarkUrl(url)).toThrowError(/profileforge_benchmark/);
    }
    expect(() => assertBenchmarkUrl("postgresql://profileforge:pw@localhost:5433/profileforge_benchmark")).not.toThrow();
  });

  it("resetBenchmarkSchema aborts on a non-benchmark URL before touching anything", async () => {
    await expect(resetBenchmarkSchema("postgresql://profileforge:pw@localhost:5433/profileforge_test")).rejects.toThrow(
      /profileforge_benchmark/,
    );
  });

  it("creates a fresh synthetic user per call", async () => {
    const a = await createRunUser();
    const b = await createRunUser();
    expect(a.id).not.toBe(b.id);
    expect(a.email).toMatch(/^bench-[0-9a-f-]+@benchmark\.local$/);
    const found = await db.user.findUnique({ where: { email: a.email } });
    expect(found?.passwordHash).toBeTruthy();
  });
});
