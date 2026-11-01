import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * System prompts live as version-controlled files in this directory
 * (src/lib/llm/prompts/) so they can be reviewed and iterated independently of
 * TypeScript. Task modules load theirs at import time — i.e. at task
 * registration — so a missing or empty prompt file fails startup loudly
 * instead of silently sending an empty system message.
 *
 * The files are developer-controlled artifacts: dynamic content (plan items,
 * source texts, JD digest, …) is still assembled in code; only placeholders
 * like {summaryMaxWords} are substituted here. Do not expose them in the UI.
 */

export const PROMPTS_DIR = join(process.cwd(), "src", "lib", "llm", "prompts");

/** Load a task's system prompt from the shipped prompts directory. */
export function loadSystemPrompt(name: string): string {
  return loadSystemPromptFrom(PROMPTS_DIR, name);
}

/** Same loader against an explicit directory (tests use a temp dir to cover
 *  the missing/empty failure paths without touching the shipped files). */
export function loadSystemPromptFrom(dir: string, name: string): string {
  let content: string;
  try {
    content = readFileSync(join(dir, name), "utf8");
  } catch (err) {
    throw new Error(
      `System prompt file "${name}" is missing from ${dir} — task registration cannot proceed. Restock it from git history.`,
      { cause: err },
    );
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error(`System prompt file "${name}" is empty — task registration cannot proceed.`);
  }
  return trimmed;
}

/** Content-hash identity of the whole prompt set, mirroring the fixture-set
 *  versioning in src/lib/benchmark/fixtures.ts: any byte change to any prompt
 *  file produces a new version, structurally invalidating old benchmark
 *  baselines (they must be re-pinned after a prompt edit). */
export function computePromptSetVersion(dir: string = PROMPTS_DIR): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update("\0");
    hash.update(readFileSync(join(dir, f)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
