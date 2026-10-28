"use client";

import { Suspense } from "react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SiteNav } from "@/components/site-nav";
import { GenerationPanel } from "@/components/generation/GenerationPanel";

type Requirement = {
  id: string;
  text: string;
  category: string;
  importance: string;
  isHardConstraint: boolean;
  order: number;
  source: string;
  userConfirmed: boolean;
};

type MatchEntry = {
  id: string;
  text: string;
  importance: string;
  isHardConstraint: boolean;
  status: "strong" | "partial" | "gap";
  matchMethod: "exact" | "approved_alias" | "semantic" | "none";
  evidence: Array<{ type: string; id: string; snippet: string }>;
  note?: string | null;
  userConfirmed?: boolean;
};

type Report = {
  overallScore: number;
  scoreBreakdown: {
    hardRequirementsMet: number;
    preferredRequirementsMet: number;
    exactMatches: number;
    aliasMatches: number;
    semanticMatches: number;
    hardWeight: number;
    preferredWeight: number;
    evidenceBonus: number;
  };
  requirements: MatchEntry[];
  recommendedKeywords: string[];
  missingKeywords: string[];
  semanticDropped: number;
  confirmable?: Record<string, string[]>;
};

type Analysis = {
  id: string;
  language: "fr" | "en";
  status: string;
  notice: string | null;
  profileVersion: number | null;
  semanticDropped: number;
  jdText: string;
  requirements: Requirement[];
  matchReport: Report | null;
};

const CATEGORIES = ["skill", "tool", "years_experience", "education", "domain", "language", "other"];

function AnalysisPageInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.ok) {
      const body = (await res.json()).analysis as Analysis;
      setAnalysis(body);
      setRequirements(body.requirements);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState after awaited fetch
    void load();
  }, [load]);

  async function call(path: string, init?: RequestInit): Promise<Response | null> {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/jobs/${id}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setStatus(body?.error?.message ?? `Request failed (${res.status}).`);
        return null;
      }
      await load();
      return res;
    } finally {
      setBusy(false);
    }
  }

  function scheduleSave(list: Requirement[]) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void call("/requirements", {
        method: "PUT",
        body: JSON.stringify({
          requirements: list.map((r) => ({
            text: r.text,
            category: r.category,
            importance: r.importance,
            isHardConstraint: r.isHardConstraint,
          })),
          finalize: false,
        }),
      });
    }, 800);
  }

  function updateRequirement(index: number, patch: Partial<Requirement>) {
    const next = requirements.map((r, i) => (i === index ? { ...r, ...patch } : r));
    setRequirements(next);
    scheduleSave(next);
  }

  function copyReport() {
    if (!analysis?.matchReport) return;
    const r = analysis.matchReport;
    const lines = [
      `ProfileForge MatchReport — score ${r.overallScore}/100`,
      `Breakdown: hard ${r.scoreBreakdown.hardRequirementsMet}, preferred ${r.scoreBreakdown.preferredRequirementsMet}, exact ${r.scoreBreakdown.exactMatches}, alias ${r.scoreBreakdown.aliasMatches}, semantic ${r.scoreBreakdown.semanticMatches}, evidence bonus +${r.scoreBreakdown.evidenceBonus}`,
      "",
      ...r.requirements.map((m) => {
        const evidence = m.evidence.map((e) => `[${e.type}] ${e.snippet}`).join(" | ");
        return `[${m.status.toUpperCase()}${m.userConfirmed ? "/confirmed" : ""}] (${m.importance}${m.isHardConstraint ? ", hard" : ""}) ${m.text} — ${m.matchMethod}${evidence ? ` — evidence: ${evidence}` : ""}${m.note ? ` (${m.note})` : ""}`;
      }),
      "",
      `Recommended keywords: ${r.recommendedKeywords.join(", ") || "—"}`,
      `Missing keywords: ${r.missingKeywords.join(", ") || "—"}`,
    ];
    void navigator.clipboard.writeText(lines.join("\n"));
    setStatus("Report copied to clipboard.");
  }

  if (!analysis) return <main className="mx-auto max-w-3xl p-6">Loading…</main>;

  const canExtract = ["created", "extracted", "failed"].includes(analysis.status);
  const canFinalize = ["extracted", "finalized"].includes(analysis.status);
  const canMatch = analysis.status === "finalized";
  const matched = analysis.status === "matched";

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <SiteNav />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Analysis</h1>
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          {status && <span>{status}</span>}
          <Badge>{analysis.status}</Badge>
        </div>
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>1. Job description</CardTitle>
          <div className="flex items-center gap-2">
            <Select
              value={analysis.language}
              onChange={(e) => void call("", { method: "PATCH", body: JSON.stringify({ language: e.target.value }) })}
              className="w-28"
              disabled={matched}
              aria-label="JD language"
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
            </Select>
            <Button disabled={!canExtract || busy} onClick={() => void call("/extract", { method: "POST", body: "{}" })}>
              {busy ? "Working…" : "Extract requirements"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm text-neutral-600">
            {analysis.jdText}
          </p>
        </CardContent>
      </Card>

      {requirements.length > 0 && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>2. Requirements ({requirements.length}) — review before matching</CardTitle>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRequirements([...requirements, { id: `new-${Date.now()}`, text: "", category: "skill", importance: "nice", isHardConstraint: false, order: requirements.length, source: "user", userConfirmed: false }]);
                }}
              >
                + Add
              </Button>
              <Button
                size="sm"
                disabled={!canFinalize || busy}
                onClick={() =>
                  void call("/requirements", {
                    method: "PUT",
                    body: JSON.stringify({
                      requirements: requirements.map((r) => ({
                        text: r.text,
                        category: r.category,
                        importance: r.importance,
                        isHardConstraint: r.isHardConstraint,
                      })),
                      finalize: true,
                    }),
                  })
                }
              >
                Finalize
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {requirements.map((r, i) => (
              <div key={r.id} className="grid grid-cols-12 items-center gap-2">
                <Input
                  className="col-span-5"
                  value={r.text}
                  onChange={(e) => updateRequirement(i, { text: e.target.value })}
                  placeholder="Requirement text"
                />
                <Select
                  className="col-span-3"
                  value={r.category}
                  onChange={(e) => updateRequirement(i, { category: e.target.value })}
                  aria-label="Category"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
                <Select
                  className="col-span-2"
                  value={r.importance}
                  onChange={(e) => updateRequirement(i, { importance: e.target.value })}
                  aria-label="Importance"
                >
                  <option value="must">must</option>
                  <option value="nice">nice</option>
                </Select>
                <label className="col-span-1 flex items-center gap-1 text-xs text-neutral-600">
                  <input
                    type="checkbox"
                    checked={r.isHardConstraint}
                    onChange={(e) => updateRequirement(i, { isHardConstraint: e.target.checked })}
                  />
                  hard
                </label>
                <Button
                  className="col-span-1"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const next = requirements.filter((_, j) => j !== i);
                    setRequirements(next);
                    scheduleSave(next);
                  }}
                  aria-label="Remove requirement"
                >
                  ✕
                </Button>
              </div>
            ))}
            <p className="text-xs text-neutral-500">
              The reviewed list is authoritative — edits autosave. Extraction assists; you decide.
            </p>
          </CardContent>
        </Card>
      )}

      {(canMatch || matched) && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>3. Match & report</CardTitle>
            <div className="flex gap-2">
              {matched ? (
                <>
                  <Button variant="outline" onClick={copyReport}>Copy report</Button>
                  <Button onClick={() => void call("/rerun", { method: "POST" }).then((res) => {
                    if (res) void res.json().then((b) => { router.push(`/jobs/${b.analysisId}`); });
                  })}>
                    Re-run against current profile
                  </Button>
                </>
              ) : (
                <Button disabled={busy} onClick={() => void call("/match", { method: "POST", body: "{}" })}>
                  {busy ? "Matching…" : "Run match"}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {analysis.notice && (
              <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-800">
                Semantic matching was unavailable — this report uses exact/alias matching only.
              </p>
            )}
            {analysis.matchReport ? (
              <ReportView report={analysis.matchReport} onConfirm={(reqId) =>
                void call("/confirm", { method: "POST", body: JSON.stringify({ requirementId: reqId }) })
              } />
            ) : (
              <p className="text-sm text-neutral-500">
                Matching is deterministic: exact → approved alias → validated semantic. {canMatch && "Run the match to see the report."}
              </p>
            )}
            {matched && (
              <p className="text-xs text-neutral-500">
                Pinned to profile v{analysis.profileVersion} · stored reports never change silently.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {matched && (
        <GenerationPanel
          analysisId={analysis.id}
          language={analysis.language}
          evidence={(analysis.matchReport?.requirements ?? []).flatMap((r) => r.evidence)}
        />
      )}
    </main>
  );
}

function ReportView({ report, onConfirm }: { report: Report; onConfirm: (requirementId: string) => void }) {
  const b = report.scoreBreakdown;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-3xl font-semibold">{report.overallScore}<span className="text-base text-neutral-400">/100</span></span>
        <Badge tone="info">hard met {b.hardRequirementsMet} · w{b.hardWeight}</Badge>
        <Badge tone="info">preferred met {b.preferredRequirementsMet} · w{b.preferredWeight}</Badge>
        <Badge tone="success">exact {b.exactMatches}</Badge>
        <Badge tone="success">alias {b.aliasMatches}</Badge>
        <Badge tone="success">semantic {b.semanticMatches}</Badge>
        <Badge tone="warning">bonus +{b.evidenceBonus}</Badge>
        {report.semanticDropped > 0 && (
          <Badge tone="warning">{report.semanticDropped} invalid proposals dropped</Badge>
        )}
      </div>

      <ul className="space-y-2">
        {report.requirements.map((m) => (
          <li key={m.id} className="rounded-md border border-neutral-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={m.status === "strong" ? "success" : m.status === "partial" ? "warning" : "danger"}>
                {m.status}
              </Badge>
              <span className="text-sm font-medium">{m.text}</span>
              <Badge>{m.matchMethod}</Badge>
              {m.importance === "must" && <Badge tone="info">must</Badge>}
              {m.isHardConstraint && <Badge tone="danger">hard</Badge>}
              {m.userConfirmed && <Badge tone="success">user-confirmed</Badge>}
              {m.isHardConstraint && m.status === "gap" && report.confirmable?.[m.id] && (
                <Button size="sm" variant="outline" onClick={() => onConfirm(m.id)}>
                  Confirm match
                </Button>
              )}
            </div>
            {m.note && <p className="mt-1 text-xs text-neutral-500">{m.note}</p>}
            {m.evidence.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600">
                {m.evidence.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono text-[10px] uppercase text-neutral-400">[{e.type}]</span> {e.snippet}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="mb-1 font-medium">Recommended keywords</p>
          <p className="text-neutral-600">{report.recommendedKeywords.join(", ") || "—"}</p>
        </div>
        <div>
          <p className="mb-1 font-medium">Missing keywords</p>
          <p className="text-neutral-600">{report.missingKeywords.join(", ") || "—"}</p>
        </div>
      </div>
    </div>
  );
}

export function AnalysisView() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-6">Loading…</main>}>
      <AnalysisPageInner />
    </Suspense>
  );
}
