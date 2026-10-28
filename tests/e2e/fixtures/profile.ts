/**
 * E2E sample data (specs/004-profile-editing-e2e, data-model.md "Fixture Set").
 * Deterministic constants only — the seed posts these through the app's own
 * routes, so every payload must satisfy the CreateSchemas
 * (src/lib/profile/sectionSchemas.ts / src/lib/validation/schemas.ts):
 * dates `YYYY-MM` | "present", company/title 1..200 chars, skill names 1..120.
 */

export const BASICS = {
  name: "Jordan Smith",
  headline: "Senior Platform Engineer",
  location: "Montreal, QC",
  email: "jordan.smith@example.com",
  phone: "+1 514 555 0142",
  summary: "Platform engineer with a decade of distributed-systems experience.",
} as const;

/** Matches SKILL_WITH_LEVEL.name exactly — the duplicate-dialog trigger (US3). */
export const DUPLICATE_SKILL_NAME = "Kubernetes";

export const EXPERIENCE = [
  {
    company: "Acme Analytics",
    title: "Senior Platform Engineer",
    location: "Montreal (remote)",
    startDate: "2021-03",
    endDate: "present",
    skillsUsed: ["Kubernetes", "Go", "Terraform"],
    bullets: [
      "Operated Kubernetes clusters serving 2M requests per day.",
      "Led a team of 5 engineers across two time zones.",
    ],
  },
  {
    company: "Globex Systems",
    title: "Backend Developer",
    location: "Ottawa",
    startDate: "2017-06",
    endDate: "2021-02",
    skillsUsed: ["Go", "PostgreSQL"],
    bullets: ["Built REST APIs handling 40k requests per minute."],
  },
  {
    // FR bilingual entry (FR-003): accented text round-trips through the editor.
    company: "Société Générale du Logiciel",
    title: "Ingénieur logiciel",
    location: "Paris",
    startDate: "2015-09",
    endDate: "2017-05",
    skillsUsed: ["Java"],
    bullets: ["Conçu des services gérant 3M de requêtes par jour."],
  },
] as const;

export const EDUCATION = [
  {
    institution: "McGill University",
    degree: "BSc",
    field: "Computer Science",
    startDate: "2011-09",
    endDate: "2015-05",
  },
] as const;

export const SKILLS = [
  // FR-008 anchor: this one carries a user-stated level…
  { name: "Kubernetes", category: "Infrastructure", level: "Expert" },
  // …and this one must stay level-less through every round-trip.
  { name: "Go", category: "Programming" },
] as const;

export const LANGUAGES = [
  { name: "English", proficiency: "Native" },
  { name: "French", proficiency: "Professional" },
] as const;

export const PROJECTS = [
  {
    name: "ATS Checker",
    description: "Open-source ATS compliance checker for résumés.",
    startDate: "2022-01",
    endDate: "present",
    bullets: ["Built an ATS compliance checker used by 400 users."],
  },
] as const;

export const CERTIFICATIONS = [
  { title: "Certified Kubernetes Administrator", issuer: "CNCF", issueDate: "2023-04" },
] as const;

/** The deliberately inconsistent fixture (US6): this seeded experience's FIRST
 *  bullet gets `review_flag = 'containment_failed'` via the seed's single
 *  direct-DB write — the only editor-unreachable state, surfacing
 *  INCONSISTENT_STATE from claim validation. Index into EXPERIENCE. */
export const INCONSISTENT_TARGET = { experienceIndex: 0, bulletIndex: 0 } as const;

/** What the seed writes to tests/e2e/.seed-state.json (data-model.md SeedState). */
export type SeedState = {
  profileVersionAfterSeed: number;
  entryIds: {
    experience: string[];
    education: string[];
    skills: string[];
    languages: string[];
    projects: string[];
    certifications: string[];
  };
  inconsistent: { entryId: string; bulletId: string };
  duplicateSkillName: string;
  /** Feature-005 fixture: a seeded matched analysis + succeeded generation. */
  generation: {
    analysisId: string;
    jobId: string;
    documentId: string;
    omittedExperienceId: string;
  };
  /** Feature-006 US3 fixture: a second analysis with a still-queued job. */
  queuedGeneration: {
    analysisId: string;
    jobId: string;
  };
  /** specs/008 US4 fixture: a quarantined (owner-less) pre-multi-user analysis. */
  legacy: {
    analysisId: string;
  };
};
