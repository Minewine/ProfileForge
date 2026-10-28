import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkConfigSchema, BenchmarkFatalError, loadBenchmarkConfig } from "@/lib/benchmark/config";

function writeConfigFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pf-bench-config-"));
  const file = join(dir, "benchmark.config.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

describe("benchmark config", () => {
  it("falls back to built-in defaults when no config file exists", () => {
    const cfg = loadBenchmarkConfig({ configFile: join(tmpdir(), "does-not-exist.json") });
    expect(cfg).toMatchObject({ mode: "live", spendCapUsd: 1.0, compare: true, updateBaseline: false, models: {} });
  });

  it("reads values from the config file", () => {
    const file = writeConfigFile({ mode: "replay", spendCapUsd: 0.25 });
    const cfg = loadBenchmarkConfig({ configFile: file });
    expect(cfg.mode).toBe("replay");
    expect(cfg.spendCapUsd).toBe(0.25);
  });

  it("CLI overrides beat the config file", () => {
    const file = writeConfigFile({ mode: "replay", spendCapUsd: 0.25, label: "from-file" });
    const cfg = loadBenchmarkConfig({ configFile: file, overrides: { mode: "live", label: "from-cli" } });
    expect(cfg.mode).toBe("live");
    expect(cfg.label).toBe("from-cli");
    expect(cfg.spendCapUsd).toBe(0.25);
  });

  it("rejects invalid JSON with exit code 3", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-bench-config-"));
    const file = join(dir, "benchmark.config.json");
    writeFileSync(file, "{ not json");
    expect(() => loadBenchmarkConfig({ configFile: file })).toThrowError(BenchmarkFatalError);
    expect(() => loadBenchmarkConfig({ configFile: file })).toThrowError(/not valid JSON/);
  });

  it("rejects a non-positive spend cap with exit code 3", () => {
    expect(() => BenchmarkConfigSchema.parse({ spendCapUsd: 0 })).toThrowError();
    expect(() => BenchmarkConfigSchema.parse({ spendCapUsd: -1 })).toThrowError();
  });

  it("rejects unknown model task keys", () => {
    const parsed = BenchmarkConfigSchema.safeParse({ models: { notARealTask: "some/model" } });
    expect(parsed.success).toBe(false);
  });

  it("accepts registered task ids as model keys", () => {
    const parsed = BenchmarkConfigSchema.safeParse({ models: { generateTailoredCV: "acme/model-x" } });
    expect(parsed.success).toBe(true);
  });
});
