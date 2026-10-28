"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Local view type over the API payload (importing lib schemas would pull
// node:crypto into the client bundle — same convention as GenerationPanel).

export type OmissionView = { type: string; id: string; reason: string; restoredMustInclude?: boolean };

/**
 * US5 omissions review: every omission with type, identifier, and reason; a
 * restore action marks the item must-include on the current version (applies
 * at the next regeneration), a regenerate affordance re-runs generation, and
 * an explicit PAGE_BUDGET_CONFLICT state is surfaced from the failed job with
 * guidance — restored items are never silently re-omitted (SC-006).
 */
export function OmissionsList({
  jobId,
  omissions,
  onRestored,
  onRegenerate,
  regenerating,
  conflictMessage,
}: {
  jobId: string;
  omissions: OmissionView[];
  onRestored: () => void | Promise<void>;
  onRegenerate: () => void;
  regenerating: boolean;
  /** The failed job's PAGE_BUDGET_CONFLICT statusError, when present. */
  conflictMessage: string | null;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore(omissionId: string) {
    setBusyId(omissionId);
    setError(null);
    try {
      const res = await fetch(
        `/api/generations/${jobId}/document/omissions/${encodeURIComponent(omissionId)}/restore`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `Restore failed (${res.status}).`);
      }
      await onRestored();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Omissions</p>
        {omissions.length > 0 && (
          <Button size="sm" variant="outline" disabled={regenerating} onClick={onRegenerate}>
            {regenerating ? "Regenerating…" : "Regenerate with restores"}
          </Button>
        )}
      </div>
      {conflictMessage && (
        <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {conflictMessage} Raise the page budget or restore fewer items, then regenerate.
        </p>
      )}
      {omissions.length === 0 ? (
        <p className="text-xs text-neutral-400">
          Nothing was omitted — every selected item fit the page budget (no hidden truncation).
        </p>
      ) : (
        <ul className="space-y-1">
          {omissions.map((omission) => (
            <li
              key={`${omission.type}-${omission.id}`}
              className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs"
            >
              <span className="font-mono font-semibold text-neutral-700">{omission.type}</span>
              <span className="font-mono text-[10px] text-neutral-500">{omission.id}</span>
              <Badge>{omission.reason}</Badge>
              {omission.restoredMustInclude ? (
                <Badge tone="success" className="ml-auto">
                  restored as must-include
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={busyId !== null}
                  onClick={() => void restore(omission.id)}
                >
                  {busyId === omission.id ? "Restoring…" : "Restore"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {omissions.length > 0 && (
        <p className="text-xs text-neutral-500">
          Restored items become must-include for the next regeneration — if they cannot fit, generation
          fails with an explicit page-budget conflict instead of omitting them again.
        </p>
      )}
    </div>
  );
}
