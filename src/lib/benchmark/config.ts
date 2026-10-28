import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Registered LLM task ids (src/lib/llm/tasks/*) — the keys of BenchmarkConfig.models.
 *  Kept as a literal list (task registration requires importing every task module;
 *  this slice adds no tasks, so the set is stable). */
export const LLM_TASK_IDS = [
  "parseCV",
  "extractRequirements",
  "semanticProposals",
  "generateTailoredCV",
  "generateCoverLetter",
] as const;
export type LlmTaskId = (typeof LLM_TASK_IDS)[number];

export const BenchmarkConfigSchema = z.object({
  mode: z.enum(["live", "replay"]).default("live"),
  models: z
    .record(z.string().min(1), z.string().min(1))
    .default({})
    .refine(
      (models) => Object.keys(models).every((k) => (LLM_TASK_IDS as readonly string[]).includes(k)),
      { message: `keys must be registered LLM task ids: ${LLM_TASK_IDS.join(", ")}` },
    ),
  spendCapUsd: z.number().positive().default(1.0),
  compare: z.boolean().default(true),
  updateBaseline: z.boolean().default(false),
  label: z.string().min(1).optional(),
  caseIds: z.array(z.string().min(1)).optional(),
});
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;
export type BenchmarkConfigInput = z.input<typeof BenchmarkConfigSchema>;

/** Aborts the run with a specific exit code: 3 = configuration/infrastructure,
 *  2 = incomplete (abort mid-run). Never a silent skip. */
export class BenchmarkFatalError extends Error {
  constructor(
    public readonly exitCode: 2 | 3,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BenchmarkFatalError";
  }
}

export const DEFAULT_CONFIG_FILE = join("benchmarks", "benchmark.config.json");

/**
 * Effective configuration = built-in defaults < config file < CLI overrides
 * (contracts/cli.md precedence). Invalid JSON or schema violations are
 * infrastructure errors (exit 3).
 */
export function loadBenchmarkConfig(args?: {
  configFile?: string;
  overrides?: BenchmarkConfigInput;
}): BenchmarkConfig {
  const file = args?.configFile ?? DEFAULT_CONFIG_FILE;
  let fileConfig: unknown = {};
  if (existsSync(file)) {
    try {
      fileConfig = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new BenchmarkFatalError(3, `Benchmark config file ${file} is not valid JSON.`, { cause: err });
    }
  }
  const fileRecord = fileConfig as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...fileRecord, ...(args?.overrides ?? {}) };
  // `models` merges per task key (flags override individual tasks while the
  // config file's other tasks persist); every other key is a shallow override.
  if (fileRecord.models !== undefined || args?.overrides?.models !== undefined) {
    merged.models = {
      ...((fileRecord.models as Record<string, string>) ?? {}),
      ...((args?.overrides?.models as Record<string, string>) ?? {}),
    };
  }
  const parsed = BenchmarkConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BenchmarkFatalError(3, `Invalid benchmark configuration: ${issues}`);
  }
  return parsed.data;
}
