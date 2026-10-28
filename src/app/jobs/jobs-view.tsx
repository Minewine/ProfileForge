"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SiteNav } from "@/components/site-nav";
import { describeError, type DescribedError } from "@/lib/client-messages";

type AnalysisSummary = {
  id: string;
  status: string;
  language: string;
  createdAt: string;
  updatedAt: string;
  requirementCount: number;
  rerunOfId: string | null;
  title: string;
  overallScore: number | null;
};

const STATUS_TONES: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  created: "default",
  extracted: "info",
  finalized: "info",
  matched: "success",
  failed: "danger",
};

export function JobsView() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/jobs");
    if (res.ok) setAnalyses(((await res.json()).analyses ?? []) as AnalysisSummary[]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState after awaited fetch
    void load();
  }, [load]);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(
          body?.error
            ? describeError(body.error.code, body.error.message)
            : { code: null, message: "Failed to create analysis.", action: null },
        );
        return;
      }
      router.push(`/jobs/${body.analysisId}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this analysis? Its requirements and report are removed too.")) return;
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <SiteNav />
      <h1 className="text-2xl font-semibold">Job descriptions</h1>

      <Card>
        <CardHeader>
          <CardTitle>Paste a job description (French or English)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="jd">Job description text</Label>
          <Textarea
            id="jd"
            className="min-h-[160px]"
            placeholder="Paste the full job description here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-xs text-neutral-500">
            {text.trim().length} characters (minimum 200). Nothing is truncated silently.
          </p>
          {error && (
            <p className="text-sm text-red-700">
              {error.code && <span className="mr-2 font-mono text-xs uppercase text-red-500">{error.code}</span>}
              {error.message}
              {error.action && <span className="block font-medium">{error.action}</span>}
            </p>
          )}
          <Button onClick={create} disabled={busy || text.trim().length < 200}>
            {busy ? "Creating…" : "Create analysis"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {analyses.length === 0 && <p className="text-sm text-neutral-500">No analyses yet.</p>}
          {analyses.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2"
            >
              <div className="min-w-0">
                <Link href={`/jobs/${a.id}`} className="truncate text-sm font-medium hover:underline">
                  {a.rerunOfId && <span className="mr-1 text-neutral-400">↻</span>}
                  {a.title}…
                </Link>
                <p className="text-xs text-neutral-500">
                  {a.status} · {a.requirementCount} requirements · {a.language.toUpperCase()} ·{" "}
                  {new Date(a.updatedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {a.overallScore != null && <Badge tone="success">score {a.overallScore}</Badge>}
                <Badge tone={STATUS_TONES[a.status] ?? "default"}>{a.status}</Badge>
                <Button size="sm" variant="ghost" onClick={() => void remove(a.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
