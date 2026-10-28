"use client";

import { Badge } from "@/components/ui/badge";

// Local view type over the API payload (importing lib schemas would pull
// node:crypto into the client bundle — same convention as GenerationPanel).

type EvidenceRefView = { type: string; id: string; snippet: string };

export type SelectionRecordView = {
  included: Array<{
    entryId: string;
    kind: "experience" | "project" | "education" | "certification";
    rank: number;
    score: number;
    basis: {
      evidenceRefs: EvidenceRefView[];
      methodCredits: string[];
      recency: number;
    };
  }>;
  generatedAt: string;
};

const KIND_LABELS: Record<SelectionRecordView["included"][number]["kind"], string> = {
  experience: "Experience",
  project: "Projects",
  education: "Education",
  certification: "Certifications",
};

/**
 * Feature 005 US1 — the inspectable selection: why each included entry made
 * the draft (rank within its section, the plan's score, the MatchReport
 * evidence that connects it to the job, recency) with links into the same
 * evidence map the provenance drill-down uses. Pre-feature versions (no
 * persisted record) render a "not recorded" note.
 */
export function SelectionView({
  selection,
  evidenceById,
}: {
  selection: SelectionRecordView | null;
  /** id → evidence ref, shared with the provenance drill-down. */
  evidenceById: Map<string, EvidenceRefView>;
}) {
  if (!selection) {
    return (
      <div className="space-y-1 border-t border-neutral-200 pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Selection</p>
        <p className="text-xs text-neutral-400">
          Not recorded for this version — it was generated before selection tracking existed.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-neutral-200 pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        Selection ({selection.included.length} entries)
      </p>
      <ul className="space-y-1">
        {selection.included.map((entry) => (
          <li
            key={`${entry.kind}-${entry.entryId}`}
            className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs"
          >
            <span className="font-mono font-semibold text-neutral-700">
              #{entry.rank} {KIND_LABELS[entry.kind]}
            </span>
            <span className="font-mono text-[10px] text-neutral-500">{entry.entryId}</span>
            <Badge tone="info">score {entry.score.toFixed(3)}</Badge>
            {entry.basis.methodCredits.map((credit) => (
              <Badge key={credit}>{credit}</Badge>
            ))}
            <Badge tone={entry.basis.recency >= 0.75 ? "success" : "default"}>
              recency {Math.round(entry.basis.recency * 100)}%
            </Badge>
            {entry.basis.evidenceRefs.length > 0 ? (
              <span className="text-neutral-500">
                evidence:{" "}
                {entry.basis.evidenceRefs.map((ref, i) => (
                  <span key={ref.id}>
                    {i > 0 && ", "}
                    <span title={ref.snippet}>{evidenceById.get(ref.id)?.snippet ?? ref.id}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-neutral-400">no direct match evidence — ranked on recency/strength</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-500">
        Entries not listed here were left out by the selection ranking — find them in the omissions
        list below with reason “selection”.
      </p>
    </div>
  );
}
