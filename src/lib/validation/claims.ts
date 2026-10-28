import { db } from "@/lib/db";
import { getProfile, type ProfileDto } from "@/lib/profile/repository";

export type ClaimFlag = {
  code: string;
  claim: string;
  severity: "blocker" | "warning";
  affectedFieldIds: string[];
  sourceEvidence: { type: string; id: string; snippet: string } | null;
  resolution: "pending" | "user_confirmed" | "edited" | "removed";
};

export type ClaimsReport = {
  flags: ClaimFlag[];
  summary: { blockers: number; warnings: number };
};

type AnyEntry = {
  id: string;
  provenance: string;
  reviewFlag?: string | null;
  sourceDocumentId?: string | null;
  sourceLocator?: unknown;
  containmentOk?: boolean | null;
  bullets?: Array<{ id: string; text: string; provenance: string; reviewFlag?: string | null; sourceDocumentId?: string | null; containmentOk?: boolean | null }>;
};

const SECTION_TO_EVIDENCE_TYPE: Record<string, string> = {
  experience: "bullet",
  education: "education",
  skills: "skill",
  languages: "skill",
  projects: "bullet",
  certifications: "certification",
};

function snippetOf(entry: AnyEntry): string {
  const candidate =
    (entry as { title?: string }).title ??
    (entry as { name?: string }).name ??
    (entry as { institution?: string }).institution ??
    (entry as { company?: string }).company ??
    (entry as { certification?: string }).certification ??
    entry.id;
  return String(candidate).slice(0, 120);
}

/**
 * Basic claim-to-evidence validation over the current profile (Fact Guard
 * groundwork, contracts/api.md): dangling provenance and unresolved
 * containment failures are blockers; inconsistent states are warnings.
 */
export async function validateProfileClaims(userId: string): Promise<ClaimsReport> {
  const profile: ProfileDto = await getProfile(userId);
  const flags: ClaimFlag[] = [];

  const docIds = new Set(
    (await db.sourceDocument.findMany({ where: { userId }, select: { id: true } })).map((d) => d.id),
  );

  const checkEntry = (section: string, entry: AnyEntry, label: string) => {
    const evidence = {
      type: SECTION_TO_EVIDENCE_TYPE[section] ?? "skill",
      id: entry.id,
      snippet: snippetOf(entry),
    };

    if (entry.provenance === "imported") {
      if (!entry.sourceDocumentId || !docIds.has(entry.sourceDocumentId)) {
        flags.push({
          code: "DANGLING_PROVENANCE",
          claim: `${label}: references a source document that no longer exists.`,
          severity: "blocker",
          affectedFieldIds: [entry.id],
          sourceEvidence: null,
          resolution: "pending",
        });
      } else if (entry.sourceLocator == null) {
        flags.push({
          code: "MISSING_LOCATOR",
          claim: `${label}: imported entry has no source locator (page/paragraph).`,
          severity: "blocker",
          affectedFieldIds: [entry.id],
          sourceEvidence: evidence,
          resolution: "pending",
        });
      }
    }

    if (entry.containmentOk === false && entry.provenance !== "user_confirmed") {
      flags.push({
        code: "CONTAINMENT_UNRESOLVED",
        claim: `${label}: not grounded in the extracted CV text — confirm, edit, or remove it.`,
        severity: "blocker",
        affectedFieldIds: [entry.id],
        sourceEvidence: evidence,
        resolution: "pending",
      });
    }

    if (entry.reviewFlag != null && entry.provenance === "user_entered") {
      flags.push({
        code: "INCONSISTENT_STATE",
        claim: `${label}: user-entered entry carries a review flag.`,
        severity: "warning",
        affectedFieldIds: [entry.id],
        sourceEvidence: evidence,
        resolution: "pending",
      });
    }

    for (const b of entry.bullets ?? []) {
      if (b.containmentOk === false && b.provenance !== "user_confirmed") {
        flags.push({
          code: "CONTAINMENT_UNRESOLVED",
          claim: `Bullet "${b.text.slice(0, 80)}…" is not grounded in the extracted CV text.`,
          severity: "blocker",
          affectedFieldIds: [b.id],
          sourceEvidence: { type: "bullet", id: b.id, snippet: b.text.slice(0, 120) },
          resolution: "pending",
        });
      }
    }
  };

  const sections: Array<[string, AnyEntry[]]> = [
    ["experience", profile.experience],
    ["education", profile.education],
    ["skills", profile.skills],
    ["languages", profile.languages],
    ["projects", profile.projects],
    ["certifications", profile.certifications],
  ];
  for (const [section, entries] of sections) {
    for (const entry of entries) {
      const label = `${section}: ${snippetOf(entry)}`;
      checkEntry(section, entry, label);
    }
  }

  return {
    flags,
    summary: {
      blockers: flags.filter((f) => f.severity === "blocker").length,
      warnings: flags.filter((f) => f.severity === "warning").length,
    },
  };
}
