import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { BenchmarkFatalError } from "@/lib/benchmark/config";
import { OutputLanguageSchema } from "@/lib/generation/schemas";
import { MIN_JD_CHARS } from "@/lib/jobs/schemas";
import { ProfileDraftSchema } from "@/lib/validation/schemas";
import { checkContainment } from "@/lib/validation/sourceContainment";

const ManifestProfileSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  purpose: z.string().min(1),
  edge: z.boolean().default(false),
});

const ManifestJdSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  language: z.enum(["en", "fr"]),
  purpose: z.string().min(1),
  hardConstraintsHeavy: z.boolean().default(false),
  weakMatch: z.boolean().default(false),
});

const ManifestCaseSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  jdId: z.string().min(1),
  outputLanguage: OutputLanguageSchema,
});

const ManifestSchema = z.object({
  profiles: z.array(ManifestProfileSchema).min(2),
  jds: z.array(ManifestJdSchema).min(3),
  cases: z.array(ManifestCaseSchema).min(1),
});

export type ManifestProfile = z.infer<typeof ManifestProfileSchema>;
export type ManifestJd = z.infer<typeof ManifestJdSchema>;
export type ManifestCase = z.infer<typeof ManifestCaseSchema>;

/** A profile fixture file: structured draft + the source text every bullet must
 *  be contained in (the benchmark imports through the same prepareDraft
 *  containment pass as a parsed CV). */
const ProfileFixtureSchema = z.object({
  language: z.enum(["en", "fr"]),
  sourceText: z.string().min(1),
  draft: ProfileDraftSchema,
});
export type ProfileFixture = z.infer<typeof ProfileFixtureSchema>;

export type JdFixture = { id: string; language: "en" | "fr"; text: string };

export type FixtureSet = {
  version: string;
  dir: string;
  manifest: z.infer<typeof ManifestSchema>;
  profiles: Map<string, ProfileFixture>;
  jds: Map<string, JdFixture>;
};

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/** Content-hash versioning (research D7): any byte change to any fixture file
 *  produces a new version, structurally invalidating old baselines. */
function computeVersion(dir: string): string {
  const files = listFilesRecursive(dir)
    .map((f) => relative(dir, f))
    .sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

function parseOrFatal<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 10).join("; ");
    throw new BenchmarkFatalError(3, `Invalid ${what}: ${issues}`);
  }
  return parsed.data;
}

/**
 * Load + validate the fixture set (FR-002). Every constraint failure is an
 * infrastructure error (exit 3) — the benchmark never runs on a malformed set.
 */
export function loadFixtureSet(dir: string): FixtureSet {
  const version = computeVersion(dir);
  const manifest = parseOrFatal(
    ManifestSchema,
    JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    "benchmarks/fixtures/manifest.json",
  );

  const problems: string[] = [];
  const profiles = new Map<string, ProfileFixture>();
  for (const entry of manifest.profiles) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, entry.file), "utf8"));
    } catch (err) {
      problems.push(`profile ${entry.id}: unreadable file ${entry.file} (${String(err).slice(0, 120)})`);
      continue;
    }
    const fixture = parseOrFatal(ProfileFixtureSchema, raw, `profile fixture ${entry.id}`);
    for (const [i, exp] of fixture.draft.experience.entries()) {
      for (const [j, bullet] of exp.bullets.entries()) {
        if (!checkContainment(bullet.text, fixture.sourceText).ok) {
          problems.push(`profile ${entry.id}: experience[${i}].bullets[${j}] is not contained in sourceText`);
        }
      }
    }
    profiles.set(entry.id, fixture);
  }

  const jds = new Map<string, JdFixture>();
  for (const entry of manifest.jds) {
    let text: string;
    try {
      text = readFileSync(join(dir, entry.file), "utf8");
    } catch (err) {
      problems.push(`jd ${entry.id}: unreadable file ${entry.file} (${String(err).slice(0, 120)})`);
      continue;
    }
    if (text.trim().length < MIN_JD_CHARS) {
      problems.push(`jd ${entry.id}: ${text.trim().length} chars — minimum is ${MIN_JD_CHARS}`);
    }
    jds.set(entry.id, { id: entry.id, language: entry.language, text });
  }

  const profileIds = new Set(manifest.profiles.map((p) => p.id));
  const jdIds = new Set(manifest.jds.map((j) => j.id));
  const caseIds = new Set<string>();
  for (const c of manifest.cases) {
    if (!profileIds.has(c.profileId)) problems.push(`case ${c.id}: unknown profileId ${c.profileId}`);
    if (!jdIds.has(c.jdId)) problems.push(`case ${c.id}: unknown jdId ${c.jdId}`);
    if (caseIds.has(c.id)) problems.push(`case ${c.id}: duplicate id`);
    caseIds.add(c.id);
  }

  if (!manifest.profiles.some((p) => p.edge)) problems.push("fixture set needs at least one edge profile");
  if (!manifest.jds.some((j) => j.hardConstraintsHeavy)) problems.push("fixture set needs a hard-constraint-heavy JD");
  if (!manifest.jds.some((j) => j.weakMatch)) problems.push("fixture set needs a poor-match JD");
  const jdLangs = new Set(manifest.jds.map((j) => j.language));
  for (const lang of ["en", "fr"] as const) {
    if (!jdLangs.has(lang)) problems.push(`fixture set needs a ${lang} JD`);
  }

  if (problems.length > 0) {
    throw new BenchmarkFatalError(3, `Fixture set ${dir} (version ${version}) is invalid:\n- ${problems.join("\n- ")}`);
  }

  return { version, dir, manifest, profiles, jds };
}
