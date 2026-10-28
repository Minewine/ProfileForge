"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FLAG_EXPLANATIONS } from "@/lib/client-messages";

// Local view types over the API payloads (importing lib schemas would pull
// node:crypto into the client bundle — same convention as GenerationPanel).

type EvidenceRefView = { type: string; id: string; snippet: string };

type FlagView = {
  code: string;
  claim: string;
  severity: "blocker" | "warning";
  affectedFieldIds?: string[];
  sourceEvidence?: EvidenceRefView[];
  resolution: "pending" | "user_confirmed" | "edited" | "removed";
  confirmedAt?: string;
};

export type ValidationReportView = {
  layersRun: { deterministic: boolean; semantic: boolean };
  flags: FlagView[];
  summary: { blockers: number; warnings: number };
};

export type ClaimRowView = { claimId: string; text: string; evidenceIds: string[] };

const RESOLUTION_LABELS: Record<FlagView["resolution"], string> = {
  pending: "pending",
  user_confirmed: "confirmed",
  edited: "edited",
  removed: "removed",
};

function resolutionTone(resolution: FlagView["resolution"]): "danger" | "success" | "default" | "info" {
  if (resolution === "pending") return "danger";
  if (resolution === "user_confirmed") return "success";
  if (resolution === "edited") return "info";
  return "default";
}

/**
 * US2 claim review: validation flags grouped by severity with codes, affected
 * claims, evidence, and resolution state; a blocker banner explains that
 * download stays disabled until every blocker is resolved; edit / remove /
 * confirm actions drive the claim-resolution routes and refresh the document.
 */
export function ClaimReview({
  jobId,
  report,
  rows,
  evidenceById,
  onChanged,
}: {
  jobId: string;
  report: ValidationReportView;
  rows: ClaimRowView[];
  evidenceById: Map<string, EvidenceRefView>;
  onChanged: () => void | Promise<void>;
}) {
  const [busyClaim, setBusyClaim] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const blockers = report.flags.filter((f) => f.severity === "blocker");
  const warnings = report.flags.filter((f) => f.severity === "warning");
  const rowByClaim = new Map(rows.map((r) => [r.claimId, r]));
  const claimsUrl = `/api/generations/${jobId}/document/claims`;

  async function act(claimId: string, run: () => Promise<Response>) {
    setBusyClaim(claimId);
    setError(null);
    try {
      const res = await run();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
        // A 409 FACTGUARD_UNAVAILABLE still stored the change — surface why, then refresh.
        setError(body?.error?.message ?? `Claim action failed (${res.status}).`);
      }
      setEditing(null);
      await onChanged();
    } finally {
      setBusyClaim(null);
    }
  }

  function startEdit(claimId: string, text: string) {
    setEditing(claimId);
    setEditText(text);
    setError(null);
  }

  function renderFlag(flag: FlagView) {
    const row = rowByClaim.get(flag.claim);
    const busy = busyClaim === flag.claim;
    const editable = row !== undefined && flag.resolution === "pending";
    return (
      <li key={`${flag.code}-${flag.claim}`} className="rounded-md border border-neutral-200 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-semibold text-neutral-700">{flag.code}</span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-neutral-400">{flag.claim}</span>
          <Badge tone={flag.severity === "blocker" ? "danger" : "warning"}>{flag.severity}</Badge>
          <span className="ml-auto flex items-center gap-2">
            <Badge tone={resolutionTone(flag.resolution)}>
              {RESOLUTION_LABELS[flag.resolution]}
              {flag.confirmedAt ? ` ${new Date(flag.confirmedAt).toLocaleString()}` : ""}
            </Badge>
          </span>
        </div>
        {row && <p className="mt-1 text-sm text-neutral-700">{row.text || <em className="text-neutral-400">(empty)</em>}</p>}
        {!row && flag.code === "SKILL_UNVERIFIED" && (
          <p className="mt-1 text-xs text-neutral-500">Skills-section entry &quot;{flag.claim}&quot;</p>
        )}
        {/* feature 006 US2: one plain-language sentence per flag kind, from the
            shared map (completeness-guarded by tests/unit/client-messages.test.ts) */}
        {FLAG_EXPLANATIONS[flag.code] && (
          <p className="mt-1 text-xs text-neutral-500">{FLAG_EXPLANATIONS[flag.code]}</p>
        )}
        {row && row.evidenceIds.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-xs text-neutral-500">
            {row.evidenceIds.map((id) => {
              const ref = evidenceById.get(id);
              return (
                <li key={id}>
                  <span className="font-mono text-[10px] uppercase text-neutral-400">[{ref?.type ?? "ref"}]</span>{" "}
                  {ref ? ref.snippet : id}
                </li>
              );
            })}
          </ul>
        )}
        {editable && (
          <div className="mt-2 space-y-2">
            {editing === flag.claim ? (
              <>
                <Textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  aria-label={`Edit claim ${flag.claim}`}
                />
                <div className="flex gap-2">
                  <Button
                    disabled={busy || !editText.trim()}
                    onClick={() =>
                      void act(flag.claim, () =>
                        fetch(claimsUrl, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ claimId: flag.claim, text: editText.trim() }),
                        }),
                      )
                    }
                  >
                    Save edit
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busyClaim !== null}
                  onClick={() => startEdit(flag.claim, row.text)}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  disabled={busyClaim !== null}
                  onClick={() =>
                    void act(flag.claim, () =>
                      fetch(claimsUrl, {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ claimId: flag.claim }),
                      }),
                    )
                  }
                >
                  Remove
                </Button>
                <Button
                  disabled={busyClaim !== null}
                  onClick={() =>
                    void act(flag.claim, () =>
                      fetch(`${claimsUrl}/${encodeURIComponent(flag.claim)}/confirm`, { method: "POST" }),
                    )
                  }
                >
                  Confirm as accurate
                </Button>
              </div>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-3">
      {!report.layersRun.semantic ? (
        <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          Fact Guard validation is unavailable (semantic layer did not run) — download stays disabled until
          re-validation succeeds. Edit any claim below to retry.
        </p>
      ) : report.summary.blockers > 0 ? (
        <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {report.summary.blockers} blocker{report.summary.blockers === 1 ? "" : "s"} pending — download is disabled
          until every claim is backed by evidence, edited, or confirmed.
        </p>
      ) : (
        <p className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-700">
          All claims validated{report.summary.warnings > 0 ? ` (${report.summary.warnings} non-blocking warning${report.summary.warnings === 1 ? "" : "s"})` : ""}.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {blockers.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Blockers</p>
          <ul className="space-y-2">{blockers.map(renderFlag)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Warnings (never block)</p>
          <ul className="space-y-2">{warnings.map(renderFlag)}</ul>
        </div>
      )}
      {report.flags.length === 0 && (
        <p className="text-xs text-neutral-400">No validation flags for this version.</p>
      )}
    </div>
  );
}
