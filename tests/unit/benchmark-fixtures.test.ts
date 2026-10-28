import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BenchmarkFatalError } from "@/lib/benchmark/config";
import { loadFixtureSet } from "@/lib/benchmark/fixtures";

const REPO_FIXTURES = join(process.cwd(), "benchmarks", "fixtures");

/** Copy the committed fixture set so mutation tests never touch the real one. */
function copiedFixtures(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pf-bench-fixtures-")), "fixtures");
  cpSync(REPO_FIXTURES, dir, { recursive: true });
  return dir;
}

function editManifest(dir: string, mutate: (manifest: Record<string, unknown>) => void): void {
  const file = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

let fixturesDir: string;

describe("benchmark fixtures", () => {
  beforeEach(() => {
    fixturesDir = copiedFixtures();
  });

  it("loads the committed fixture set with a content-hash version", () => {
    const set = loadFixtureSet(REPO_FIXTURES);
    expect(set.version).toMatch(/^[0-9a-f]{16}$/);
    expect(set.manifest.cases).toHaveLength(4);
    expect(set.profiles.get("en-standard")?.draft.experience).toHaveLength(2);
    expect(set.jds.get("fr-poor-match")?.language).toBe("fr");
  });

  it("is stable: identical content produces an identical version", () => {
    expect(loadFixtureSet(REPO_FIXTURES).version).toBe(loadFixtureSet(REPO_FIXTURES).version);
  });

  it("changes the version when any fixture byte changes", () => {
    const before = loadFixtureSet(fixturesDir).version;
    const jd = join(fixturesDir, "jds", "en-standard.txt");
    writeFileSync(jd, readFileSync(jd, "utf8") + "\n");
    expect(loadFixtureSet(fixturesDir).version).not.toBe(before);
  });

  it("rejects a case referencing an unknown profile", () => {
    editManifest(fixturesDir, (m) => {
      (m.cases as Array<Record<string, unknown>>)[0].profileId = "no-such-profile";
    });
    expect(() => loadFixtureSet(fixturesDir)).toThrowError(BenchmarkFatalError);
    expect(() => loadFixtureSet(fixturesDir)).toThrowError(/no-such-profile/);
  });

  it("rejects a JD shorter than the product minimum", () => {
    writeFileSync(join(fixturesDir, "jds", "en-standard.txt"), "Too short.");
    expect(() => loadFixtureSet(fixturesDir)).toThrowError(/minimum is 200/);
  });

  it("rejects a profile bullet that is not contained in its source text", () => {
    const file = join(fixturesDir, "profiles", "en-standard.json");
    const profile = JSON.parse(readFileSync(file, "utf8")) as {
      draft: { experience: Array<{ bullets: Array<{ text: string }> }> };
    };
    profile.draft.experience[0].bullets[0].text = "Invented sentence that appears nowhere in the source text.";
    writeFileSync(file, JSON.stringify(profile, null, 2));
    expect(() => loadFixtureSet(fixturesDir)).toThrowError(/not contained in sourceText/);
  });

  it("rejects a set with no edge profile", () => {
    editManifest(fixturesDir, (m) => {
      for (const p of m.profiles as Array<Record<string, unknown>>) p.edge = false;
    });
    expect(() => loadFixtureSet(fixturesDir)).toThrowError(/edge profile/);
  });
});
