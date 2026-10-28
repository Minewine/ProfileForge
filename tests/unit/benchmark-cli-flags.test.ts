import { describe, expect, it } from "vitest";
import { loadBenchmarkConfig } from "@/lib/benchmark/config";

/**
 * --models parsing semantics (US4, contracts/cli.md): `task=model` pairs,
 * comma-separated, merged over the config file; unknown task ids and malformed
 * pairs are exit-3 configuration errors.
 */

function parseModels(raw: string, fileModels: Record<string, string> = {}): Record<string, string> {
  // Mirror of the CLI's merge: config file < --models override, then schema
  // validation (task-key allowlist) — exercised through loadBenchmarkConfig.
  const cfg = loadBenchmarkConfig({
    configFile: joinTmp(writeFile({ models: fileModels })),
    overrides: { models: parsePairs(raw) },
  });
  return cfg.models as Record<string, string>;
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function joinTmp(file: string): string {
  return file;
}

function writeFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pf-bench-models-"));
  const file = join(dir, "benchmark.config.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

function parsePairs(raw: string): Record<string, string> {
  const models: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [task, model] = pair.split("=", 2);
    if (!task || !model) throw new Error(`--models entries must look like task=model (got "${pair}")`);
    models[task.trim()] = model.trim();
  }
  return models;
}

describe("--models parsing (US4)", () => {
  it("parses task=model pairs", () => {
    expect(parseModels("generateTailoredCV=acme/model-x,parseCV=acme/econ")).toEqual({
      generateTailoredCV: "acme/model-x",
      parseCV: "acme/econ",
    });
  });

  it("merges over the config file models", () => {
    const merged = parseModels("generateTailoredCV=acme/override", { parseCV: "acme/from-file" });
    expect(merged).toEqual({ parseCV: "acme/from-file", generateTailoredCV: "acme/override" });
  });

  it("rejects unknown task ids", () => {
    expect(() =>
      loadBenchmarkConfig({
        configFile: joinTmp(writeFile({})),
        overrides: { models: parsePairs("notATask=acme/model") },
      }),
    ).toThrowError(/registered LLM task ids/);
  });

  it("rejects malformed pairs at the CLI boundary", () => {
    expect(() => parsePairs("generateTailoredCV")).toThrowError(/task=model/);
    expect(() => parsePairs("=acme/model")).toThrowError(/task=model/);
  });
});
