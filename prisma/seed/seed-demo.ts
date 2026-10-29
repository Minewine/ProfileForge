/**
 * Idempotent demo seed (README → "Demo accounts"): creates the FR/EN demo
 * accounts with fully populated profiles and a pre-matched sample analysis.
 * The analysis requirements are hand-extracted from fixtures/demo-jd-{fr,en}.txt
 * (standing in for the LLM extraction step); matching and scoring run the app's
 * real deterministic engine, so no LLM calls happen anywhere.
 *
 * Usage:
 *   npm run seed:demo-fr
 *   npm run seed:demo-en
 *   npm run demo:reset     # drop both demo users, then re-seed both
 *
 * Requires the dev database (README Setup: docker compose up -d, then
 * npx prisma migrate dev) and DATABASE_URL from .env. Safe to re-run: the demo
 * user's profile (sections cascade) and analyses are dropped and recreated,
 * so the canned report's evidence refs always point at live rows.
 * Demo-only by design: rows belonging to other accounts are never touched, and
 * demo:reset refuses to drop an account that owns uploads or a saved OpenRouter
 * key (that would not be an untouched demo account). Note that uploaded files
 * live on disk: deleting the user removes their DB rows, not the blobs.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { hashPassword } from "../../src/lib/auth/password";
import { CredentialsSchema, normalizeEmail } from "../../src/lib/auth/schemas";
import { deriveKeywords, matchRequirements } from "../../src/lib/matching/engine";
import type { EngineRequirement } from "../../src/lib/matching/engine";
import { scoreReport } from "../../src/lib/matching/score";
import { MatchReportSchema, MIN_JD_CHARS, RequirementInputSchema } from "../../src/lib/jobs/schemas";
import type { MatchReport, MatchReportExtras } from "../../src/lib/jobs/schemas";
import {
  BasicsSchema,
  CertificationInputSchema,
  EducationInputSchema,
  ExperienceInputSchema,
  LanguageCodeSchema,
  LanguageSkillInputSchema,
  ProjectInputSchema,
  SkillInputSchema,
} from "../../src/lib/validation/schemas";
import type { ProfileDto } from "../../src/lib/profile/repository";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const SPEC_FILES = {
  fr: "prisma/seed/demo-fr.json",
  en: "prisma/seed/demo-en.json",
} as const;
export type Lang = keyof typeof SPEC_FILES;

type SectionSpec = Record<string, unknown>;
type RequirementSpec = Record<string, unknown>;

export type DemoSpec = {
  email: string;
  password: string;
  profile: {
    language: string;
    basics: SectionSpec;
    experiences: Array<SectionSpec>;
    educations: Array<SectionSpec>;
    skills: Array<SectionSpec>;
    languages: Array<SectionSpec>;
    projects: Array<SectionSpec>;
    certifications: Array<SectionSpec>;
  };
  analysis: {
    jdFile: string;
    jdRole: string;
    jdCompany: string;
    requirements: Array<RequirementSpec>;
  };
};

export async function loadSpec(lang: Lang): Promise<{ spec: DemoSpec; jdText: string }> {
  if (!existsSync(path.resolve("package.json"))) {
    throw new Error("Run from the repo root — use npm run seed:demo-fr / seed:demo-en / demo:reset");
  }
  const spec = JSON.parse(await readFile(path.resolve(SPEC_FILES[lang]), "utf8")) as DemoSpec;
  // Same shape the login route accepts: guards email format and the 8-char
  // password minimum, so a bad fixture fails at load time, not at login.
  CredentialsSchema.parse({ email: spec.email, password: spec.password });
  LanguageCodeSchema.parse(spec.profile.language);
  const jdText = (await readFile(path.resolve(spec.analysis.jdFile), "utf8")).trim();
  if (jdText.length < MIN_JD_CHARS) {
    throw new Error(
      `${spec.analysis.jdFile}: sample JD is only ${jdText.length} chars (minimum ${MIN_JD_CHARS})`,
    );
  }
  return { spec, jdText };
}

/**
 * Validates the fixture's profile sections against the app's zod input schemas
 * (so seeded rows stay editable through the app), then maps them onto
 * profile-create input — only the core fields are passed to Prisma, provenance
 * stays at its column defaults, and Json columns never see `null`.
 * Exported for tests/unit/demo-seed-fixtures.test.ts.
 */
export function parseSpecSections(spec: DemoSpec) {
  const basics = BasicsSchema.parse(spec.profile.basics);
  const experiences = spec.profile.experiences.map((e, i) => {
    const input = ExperienceInputSchema.parse({
      company: e.company,
      title: e.title,
      location: e.location ?? null,
      startDate: e.startDate ?? null,
      endDate: e.endDate ?? null,
      skillsUsed: (e.skillsUsed as string[] | undefined) ?? [],
      order: i,
      bullets: ((e.bullets as string[] | undefined) ?? []).map((text, j) => ({ text, order: j })),
    });
    return {
      company: input.company,
      title: input.title,
      location: input.location ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      skillsUsed: input.skillsUsed,
      order: input.order,
      bullets: { create: input.bullets.map((b) => ({ text: b.text, order: b.order })) },
    };
  });
  const educations = spec.profile.educations.map((e, i) => {
    const input = EducationInputSchema.parse({
      institution: e.institution,
      degree: e.degree ?? null,
      field: e.field ?? null,
      startDate: e.startDate ?? null,
      endDate: e.endDate ?? null,
      grade: e.grade ?? null,
      order: i,
    });
    return {
      institution: input.institution,
      degree: input.degree ?? null,
      field: input.field ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      grade: input.grade ?? null,
      order: input.order,
    };
  });
  const skills = spec.profile.skills.map((s, i) => {
    const input = SkillInputSchema.parse({
      name: s.name,
      category: s.category ?? null,
      aliases: (s.aliases as string[] | undefined) ?? [],
      order: i,
    });
    return { name: input.name, category: input.category ?? null, aliases: input.aliases, order: input.order };
  });
  const languages = spec.profile.languages.map((l, i) => {
    const input = LanguageSkillInputSchema.parse({
      name: l.name,
      proficiency: l.proficiency ?? null,
      order: i,
    });
    return { name: input.name, proficiency: input.proficiency ?? null, order: input.order };
  });
  const projects = spec.profile.projects.map((p, i) => {
    const input = ProjectInputSchema.parse({
      name: p.name,
      description: p.description ?? null,
      link: p.link ?? null,
      startDate: p.startDate ?? null,
      endDate: p.endDate ?? null,
      order: i,
      bullets: ((p.bullets as string[] | undefined) ?? []).map((text, j) => ({ text, order: j })),
    });
    return {
      name: input.name,
      description: input.description ?? null,
      link: input.link ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      order: input.order,
      bullets: { create: input.bullets.map((b) => ({ text: b.text, order: b.order })) },
    };
  });
  const certifications = spec.profile.certifications.map((c, i) => {
    const input = CertificationInputSchema.parse({
      title: c.title,
      issuer: c.issuer ?? null,
      issueDate: c.issueDate ?? null,
      order: i,
    });
    return { title: input.title, issuer: input.issuer ?? null, issueDate: input.issueDate ?? null, order: input.order };
  });
  return { basics, experiences, educations, skills, languages, projects, certifications };
}

const includeAll = {
  experiences: { orderBy: { order: "asc" as const }, include: { bullets: { orderBy: { order: "asc" as const } } } },
  educations: { orderBy: { order: "asc" as const } },
  skills: { orderBy: { order: "asc" as const } },
  languages: { orderBy: { order: "asc" as const } },
  projects: { orderBy: { order: "asc" as const }, include: { bullets: { orderBy: { order: "asc" as const } } } },
  certifications: { orderBy: { order: "asc" as const } },
};

async function seedDemo(spec: DemoSpec, jdText: string) {
  const email = normalizeEmail(spec.email);
  const passwordHash = await hashPassword(spec.password);
  const user = await db.user.upsert({
    where: { email },
    update: { passwordHash }, // keep the demo password in sync with the fixture
    create: { email, passwordHash },
  });

  // A reseed is a clean drop: the profile (sections + snapshots cascade) and
  // this user's analyses (requirements cascade) go away, then everything is
  // recreated with fresh ids so evidence refs in the canned report stay valid.
  await db.jobAnalysis.deleteMany({ where: { userId: user.id } });
  await db.profile.deleteMany({ where: { userId: user.id } });

  const { basics, experiences, educations, skills, languages, projects, certifications } = parseSpecSections(spec);

  const profile = await db.profile.create({
    data: {
      userId: user.id,
      language: spec.profile.language,
      basics,
      experiences: { create: experiences },
      educations: { create: educations },
      skills: { create: skills },
      languages: { create: languages },
      projects: { create: projects },
      certifications: { create: certifications },
    },
    include: includeAll,
  });

  const requirements = spec.analysis.requirements.map((r) => RequirementInputSchema.parse(r));
  const analysis = await db.jobAnalysis.create({
    data: {
      userId: user.id,
      jdText,
      language: spec.profile.language,
      status: "finalized",
      jdRole: spec.analysis.jdRole,
      jdCompany: spec.analysis.jdCompany,
      requirements: {
        create: requirements.map((r, order) => ({
          text: r.text,
          category: r.category,
          importance: r.importance,
          isHardConstraint: r.isHardConstraint,
          order,
          source: "extracted",
        })),
      },
    },
    include: { requirements: { orderBy: { order: "asc" as const } } },
  });

  // Deterministic match + score with the production engine (no LLM pass).
  // Map Prisma's plural relation keys onto ProfileDto's singular ones; section
  // rows carry no Date columns, so the rows structurally match the DTO.
  const engineProfile = {
    id: profile.id,
    version: profile.version,
    language: profile.language,
    basics: profile.basics,
    experience: profile.experiences,
    education: profile.educations,
    skills: profile.skills,
    languages: profile.languages,
    projects: profile.projects,
    certifications: profile.certifications,
    lowConfidenceCount: 0,
    updatedAt: profile.updatedAt.toISOString(),
  } as unknown as ProfileDto;
  const engineRequirements: EngineRequirement[] = analysis.requirements.map((r) => ({
    id: r.id,
    text: r.text,
    category: r.category,
    importance: r.importance,
    isHardConstraint: r.isHardConstraint,
    userConfirmed: r.userConfirmed,
  }));
  const { matches, confirmable, semanticDropped } = matchRequirements(engineRequirements, engineProfile, null);
  const keywords = deriveKeywords(matches);
  const { overallScore, scoreBreakdown } = scoreReport(matches);
  const report = {
    overallScore,
    scoreBreakdown,
    requirements: matches,
    recommendedKeywords: keywords.recommended,
    missingKeywords: keywords.missing,
    semanticDropped,
    confirmable,
  } satisfies MatchReport & MatchReportExtras;
  // Canonical-shape assertion before persistence (the stored report additionally
  // carries the `confirmable` extension, which zod would strip on `.parse()`).
  MatchReportSchema.parse(report);

  await db.jobAnalysis.update({
    where: { id: analysis.id },
    data: {
      status: "matched",
      statusError: null,
      profileVersion: profile.version,
      matchReport: report,
      semanticDropped,
      notice: null,
    },
  });

  const expBullets = profile.experiences.reduce((n, e) => n + e.bullets.length, 0);
  const projBullets = profile.projects.reduce((n, p) => n + p.bullets.length, 0);
  const strong = matches.filter((m) => m.status === "strong").length;
  const partial = matches.filter((m) => m.status === "partial").length;
  const gaps = matches.filter((m) => m.status === "gap").length;
  const hard = matches.filter((m) => m.isHardConstraint);
  const hardMet = hard.filter((m) => m.status !== "gap").length;
  console.log(`✓ ${email} (${basics.name})`);
  console.log(
    `  profile: ${profile.experiences.length} experiences (${expBullets} bullets), ` +
      `${profile.educations.length} education, ${profile.skills.length} skills, ` +
      `${profile.languages.length} languages, ${profile.projects.length} projects (${projBullets} bullets), ` +
      `${profile.certifications.length} certifications`,
  );
  console.log(
    `  sample analysis "${spec.analysis.jdCompany}" — score ${overallScore}/100 ` +
      `(hard ${hardMet}/${hard.length}) — strong ${strong}, partial ${partial}, gap ${gaps}`,
  );
}

async function main() {
  const mode = process.argv[2];
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env (see README Setup).");
  }
  if (mode === "reset") {
    const loaded = await Promise.all([loadSpec("fr"), loadSpec("en")]);
    for (const { spec } of loaded) {
      const email = normalizeEmail(spec.email);
      const user = await db.user.findUnique({ where: { email } });
      if (!user) {
        console.log(`nothing to drop for ${email}`);
        continue;
      }
      // Safety guard: an account with uploads or a saved OpenRouter key is not
      // an untouched demo account — refuse instead of cascade-wiping real work.
      const uploads = await db.sourceDocument.count({ where: { userId: user.id } });
      const savedKey = await db.appSettings.findFirst({
        where: { userId: user.id, openRouterKeyEncrypted: { not: null } },
        select: { id: true },
      });
      if (uploads > 0 || savedKey) {
        throw new Error(
          `${email} owns ${uploads} uploaded document(s)` +
            `${savedKey ? " and a saved OpenRouter key" : ""} — inspect and delete it manually first.`,
        );
      }
      // Cascades: sessions, profile + sections + snapshots, analyses + requirements,
      // source documents, usage logs, settings — demo rows only.
      await db.user.delete({ where: { id: user.id } });
      console.log(`dropped ${email}`);
    }
    for (const { spec, jdText } of loaded) await seedDemo(spec, jdText);
  } else if (mode === "fr" || mode === "en") {
    const { spec, jdText } = await loadSpec(mode);
    await seedDemo(spec, jdText);
  } else {
    console.error("Usage: npm run seed:demo-fr | npm run seed:demo-en | npm run demo:reset");
    process.exitCode = 1;
    return;
  }
  console.log("\nLog in at http://localhost:3000/login — credentials in README → Demo accounts.");
}

// CLI entry point — guarded so the fixtures' unit test can import this module.
if (process.argv[1]?.endsWith("seed-demo.ts")) {
  main()
    .catch((err) => {
      console.error(`✋ demo seed failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
