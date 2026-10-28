import type { ProfileDto } from "@/lib/profile/repository";

export type DigestEntry = { id: string; type: "skill" | "bullet" | "education" | "certification"; text: string };

const MAX_DIGEST_ENTRIES = 120;

/**
 * Compact, recency-ordered profile digest for the semantic-proposals task —
 * IDs + snippets only (payload minimization). The LLM cites these IDs; the
 * engine validates them against the profile.
 */
export function buildProfileDigest(profile: ProfileDto): DigestEntry[] {
  const entries: DigestEntry[] = [];

  // experiences first (recency = array order from the repository), bullets then role header
  for (const exp of [...profile.experience].reverse()) {
    for (const bullet of exp.bullets ?? []) {
      entries.push({
        id: bullet.id,
        type: "bullet",
        text: `${exp.title} — ${exp.company}: ${bullet.text}`.slice(0, 300),
      });
    }
    if ((exp.bullets ?? []).length === 0) {
      entries.push({
        id: exp.id,
        type: "bullet",
        text: `${exp.title} — ${exp.company} (${exp.startDate ?? "?"} → ${exp.endDate ?? "?"}) using ${(exp.skillsUsed ?? []).join(", ")}`.slice(0, 300),
      });
    }
  }
  for (const project of [...profile.projects].reverse()) {
    for (const bullet of project.bullets ?? []) {
      entries.push({ id: bullet.id, type: "bullet", text: `${project.name}: ${bullet.text}`.slice(0, 300) });
    }
    if ((project.bullets ?? []).length === 0 && project.description) {
      entries.push({ id: project.id, type: "bullet", text: `${project.name}: ${project.description}`.slice(0, 300) });
    }
  }
  for (const skill of profile.skills) {
    entries.push({
      id: skill.id,
      type: "skill",
      text: [skill.name, skill.category, skill.level].filter(Boolean).join(" · ").slice(0, 200),
    });
  }
  for (const edu of profile.education) {
    entries.push({
      id: edu.id,
      type: "education",
      text: [edu.degree, edu.field, edu.institution].filter(Boolean).join(" · ").slice(0, 200),
    });
  }
  for (const cert of profile.certifications) {
    entries.push({
      id: cert.id,
      type: "certification",
      text: [cert.title, cert.issuer].filter(Boolean).join(" · ").slice(0, 200),
    });
  }

  return entries.slice(0, MAX_DIGEST_ENTRIES);
}
