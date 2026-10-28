"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { OmissionsList } from "@/components/generation/OmissionsList";
import { SelectionView, type SelectionRecordView } from "@/components/generation/SelectionView";
import { describeError, FLAG_EXPLANATIONS, type DescribedError } from "@/lib/client-messages";

// Local view types over the API payloads (importing lib schemas would pull
// node:crypto into the client bundle — same convention as the jobs page).

type EvidenceRefView = { type: string; id: string; snippet: string };

type OmissionView = { type: string; id: string; reason: string; restoredMustInclude?: boolean };

type CVContentView = {
  claimIdVersion: number;
  summary: string;
  summaryProvenance: EvidenceRefView[];
  experience: Array<{
    id: string;
    bullets: Array<{ claimId: string; text: string; sourceBulletIds: string[]; rationale?: string }>;
  }>;
  projects: Array<{
    id: string;
    bullets: Array<{ claimId: string; text: string; sourceBulletIds: string[] }>;
  }>;
  education: Array<{ id: string; claimId: string; text: string; sourceIds: string[] }>;
  certifications: Array<{ id: string; claimId: string; text: string; sourceIds: string[] }>;
  skills: string[];
  omissions: OmissionView[];
};

/** US6: cover-letter content — paragraphs with plan-resolved evidence. */
type LetterContentView = {
  claimIdVersion: number;
  paragraphs: Array<{ claimId: string; text: string; evidence: EvidenceRefView[] }>;
  tone: string;
  omissions: OmissionView[];
};

type ContentView = CVContentView | LetterContentView;

const isLetterContent = (content: ContentView): content is LetterContentView => "paragraphs" in content;

type JobView = {
  id: string;
  kind: string;
  status: string;
  statusError: string | null;
  attempt: number;
  notice: string | null;
  profileVersion: number;
};

type ExtractionCheckView = {
  passed: boolean;
  pages: number;
  level1: { passed: boolean; elements: Array<{ element: string; expected: string; found: boolean }> };
  level2: {
    passed: boolean;
    threshold: number;
    blocks: Array<{ claimId: string; kind: string; ratio: number; ok: boolean }>;
  };
};

type DocumentView = {
  documentId: string;
  currentVersion: number | null;
  downloadable: { pdf: boolean; docx: boolean; txt: boolean };
  summary: { blockers: number; warnings: number };
  version: {
    version: number;
    revision: number;
    content: ContentView;
    validationReport: ValidationReportView;
    /** Feature 005 SelectionRecord — null for pre-feature versions. */
    selection: SelectionRecordView | null;
    extractionCheck?: ExtractionCheckView;
  } | null;
};

/** Warnings-only validation report (Fact Guard removed — informational). */
type ValidationReportView = {
  flags: Array<{ code: string; claim: string; severity: string }>;
  summary: { blockers: number; warnings: number };
};

type PollPayload = { job: JobView; document: DocumentView | null };

const POLL_MS = 1500;
const ACTIVE_STATUSES = ["queued", "running"];
const MAX_NOTES = 2000;
/** US3 (contracts/ui-states.md): disabled controls state WHY — generation in progress. */
const IN_PROGRESS_TITLE = "Generation in progress";

type ClaimRow = {
  claimId: string;
  group: string;
  text: string;
  rationale?: string;
  evidenceIds: string[];
};

/** Flatten the CV content into per-claim rows for the provenance drill-down. */
function claimRows(content: ContentView): ClaimRow[] {
  if (isLetterContent(content)) {
    return content.paragraphs.map((p) => ({
      claimId: p.claimId,
      group: "Letter",
      text: p.text,
      evidenceIds: p.evidence.map((e) => e.id),
    }));
  }
  const rows: ClaimRow[] = [
    {
      claimId: "summary",
      group: "Summary",
      text: content.summary,
      evidenceIds: content.summaryProvenance.map((e) => e.id),
    },
  ];
  for (const entry of content.experience) {
    for (const b of entry.bullets) {
      rows.push({
        claimId: b.claimId,
        group: "Experience",
        text: b.text,
        rationale: b.rationale,
        evidenceIds: b.sourceBulletIds,
      });
    }
  }
  for (const project of content.projects) {
    for (const b of project.bullets) {
      rows.push({ claimId: b.claimId, group: "Projects", text: b.text, evidenceIds: b.sourceBulletIds });
    }
  }
  for (const edu of content.education) {
    rows.push({ claimId: edu.claimId, group: "Education", text: edu.text, evidenceIds: edu.sourceIds });
  }
  for (const cert of content.certifications) {
    rows.push({ claimId: cert.claimId, group: "Certifications", text: cert.text, evidenceIds: cert.sourceIds });
  }
  return rows;
}

function statusTone(status: string): "default" | "info" | "success" | "danger" | "warning" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "warning";
  if (ACTIVE_STATUSES.includes(status)) return "info";
  return "default";
}

/**
 * US1 generation panel for matched analyses: settings form → async job →
 * polling status → version summary with per-claim provenance drill-down
 * (evidence refs resolved against the match evidence / pinned snapshot).
 */
export function GenerationPanel({
  analysisId,
  language,
  evidence,
}: {
  analysisId: string;
  /** The analysis's JD language — the default output language. */
  language: "fr" | "en";
  /** MatchReport evidence refs (id → snippet lookup for the drill-down). */
  evidence: EvidenceRefView[];
}) {
  const [kind, setKind] = useState<"cv" | "cover_letter">("cv");
  const [latestByKind, setLatestByKind] = useState<Partial<Record<"cv" | "cover_letter", string>>>({});
  const [outputLanguage, setOutputLanguage] = useState<string>(language);
  const [pageBudget, setPageBudget] = useState(2);
  const [summaryMaxWords, setSummaryMaxWords] = useState(60); // feature 005 US3: 30..120, default 60
  const [templateId, setTemplateId] = useState<"ats" | "designed">("ats"); // phase 8: ATS stays the default
  const [tone, setTone] = useState("professional");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [poll, setPoll] = useState<PollPayload | null>(null);
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (id: string) => {
    const res = await fetch(`/api/generations/${id}`);
    if (res.ok) setPoll(await res.json());
  }, []);

  // Resume the most recent generation for this analysis on mount, whichever
  // kind it was — resuming the CV unconditionally would hide a freshly
  // generated cover letter the moment the user leaves this page. The list is
  // newest-first, so the first hit per kind is that kind's latest job.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/generations?analysisId=${analysisId}`);
      if (!res.ok || cancelled) return;
      const { generations } = (await res.json()) as {
        generations: Array<{ generationJobId: string; kind: string }>;
      };
      const latest: Partial<Record<"cv" | "cover_letter", string>> = {};
      for (const g of generations) {
        const k = g.kind === "cover_letter" ? "cover_letter" : "cv";
        if (!latest[k]) latest[k] = g.generationJobId;
      }
      if (cancelled) return;
      setLatestByKind(latest);
      const first = generations[0];
      if (first && !cancelled) {
        setJobId(first.generationJobId);
        setKind(first.kind === "cover_letter" ? "cover_letter" : "cv");
        await refresh(first.generationJobId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analysisId, refresh]);

  // Poll while the job is active; stops once a terminal status lands.
  useEffect(() => {
    if (!jobId) return;
    const status = poll?.job.status;
    if (!status || !ACTIVE_STATUSES.includes(status)) return;
    const timer = setTimeout(() => void refresh(jobId), POLL_MS);
    return () => clearTimeout(timer);
  }, [jobId, poll, refresh]);

  async function generate(selectedKind: "cv" | "cover_letter" = kind) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisId,
          kind: selectedKind,
          settings: {
            outputLanguage,
            ...(selectedKind === "cover_letter" ? { tone } : {}),
            ...(selectedKind === "cv" ? { pageBudget, summaryMaxWords, templateId } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
        setError(
          body?.error
            ? describeError(body.error.code, body.error.message)
            : { code: null, message: `Generation request failed (${res.status}).`, action: null },
        );
        return;
      }
      const created = (await res.json()) as { generationJobId: string };
      setJobId(created.generationJobId);
      setKind(selectedKind);
      setLatestByKind((prev) => ({ ...prev, [selectedKind]: created.generationJobId }));
      setOpenClaim(null);
      await refresh(created.generationJobId);
    } finally {
      setBusy(false);
    }
  }

  /** Show the latest job of the other kind without regenerating (both exist). */
  async function switchKind(target: "cv" | "cover_letter") {
    const id = latestByKind[target];
    if (!id || target === kind || busy || active) return;
    setKind(target);
    setJobId(id);
    setPoll(null);
    setOpenClaim(null);
    await refresh(id);
  }

  /** US6: copy the letter's plain-text artifact to the clipboard. */
  async function copyLetterText() {
    if (!jobId) return;
    const res = await fetch(`/api/generations/${jobId}/download?format=txt`);
    if (!res.ok) return;
    await navigator.clipboard.writeText(await res.text());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const job = poll?.job ?? null;
  const document = poll?.document ?? null;
  const content = document?.version?.content ?? null;
  const firstPollPending = jobId !== null && poll === null; // contracts/ui-states.md: honest first-poll state
  const active = job != null && ACTIVE_STATUSES.includes(job.status);
  const rows = content ? claimRows(content) : [];

  // id → evidence ref: MatchReport evidence plus the CV summary's own provenance snippets
  const evidenceById = new Map<string, EvidenceRefView>([
    ...evidence.map((e) => [e.id, e] as const),
    ...(content && !isLetterContent(content)
      ? content.summaryProvenance.map((e) => [e.id, e] as const)
      : []),
  ]);
  const extraction = document?.version?.extractionCheck ?? null;
  const gateFailed = extraction !== null && !extraction.passed;
  /** US5: the explicit must-include conflict surfaced from the failed job (SC-006). */
  const budgetConflict =
    job?.status === "failed" && job.statusError?.includes("PAGE_BUDGET_CONFLICT") ? job.statusError : null;

  // Feature 006 US2 (data-model.md ExportGateState): the download area derives
  // its per-gate explanations from the polled payload — no API change. The
  // server's computeDownloadable stays the authority on WHETHER downloads open.
  // Since the Fact Guard removal the only closable gate is the PDF extraction
  // check — the validation report is warnings-only and gates nothing.

  /** Why a format's download button is disabled (live gate matrix, R12). */
  function downloadDisabledReason(format: "pdf" | "docx" | "txt"): string {
    if (format === "pdf" && gateFailed) return "export verification failed";
    return "not generated yet";
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>4. Generate CV &amp; cover letter</CardTitle>
        <span className="flex items-center gap-2">
          {job && <Badge tone={statusTone(job.status)}>{job.status}</Badge>}
          {(busy || (job !== null && ACTIVE_STATUSES.includes(job.status))) && (
            <span
              data-testid="gen-progress"
              aria-label="Generation in progress"
              className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-blue-500"
            />
          )}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        {(["cv", "cover_letter"] as const).some((k) => latestByKind[k] && k !== kind) && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-neutral-400">View latest</span>
            {(["cv", "cover_letter"] as const).map((k) =>
              latestByKind[k] ? (
                <Button
                  key={k}
                  size="sm"
                  variant={k === kind ? "default" : "outline"}
                  disabled={busy || active}
                  title={busy || active ? IN_PROGRESS_TITLE : undefined}
                  onClick={() => void switchKind(k)}
                >
                  {k === "cv" ? "CV" : "Cover letter"}
                </Button>
              ) : null,
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="gen-output-language">Output language</Label>
            <Select
              id="gen-output-language"
              value={outputLanguage}
              onChange={(e) => setOutputLanguage(e.target.value)}
              disabled={busy || active}
              title={IN_PROGRESS_TITLE}
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="gen-page-budget">Page budget (CV)</Label>
            <Select
              id="gen-page-budget"
              value={String(pageBudget)}
              onChange={(e) => setPageBudget(Number(e.target.value))}
              disabled={busy || active}
              title={IN_PROGRESS_TITLE}
            >
              <option value="1">1 page</option>
              <option value="2">2 pages</option>
              <option value="3">3 pages</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="gen-template">Template (CV)</Label>
            <Select
              id="gen-template"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value === "designed" ? "designed" : "ats")}
              disabled={busy || active}
              title={IN_PROGRESS_TITLE}
            >
              <option value="ats">ATS — single column</option>
              <option value="designed">Designed — two column</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="gen-tone">Tone (letter)</Label>
            <Select id="gen-tone" value={tone} onChange={(e) => setTone(e.target.value)} disabled={busy || active} title={IN_PROGRESS_TITLE}>
              <option value="professional">Professional</option>
              <option value="enthusiastic">Enthusiastic</option>
              <option value="formal">Formal</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="gen-summary-words">Summary length (CV)</Label>
            <Select
              id="gen-summary-words"
              value={String(summaryMaxWords)}
              onChange={(e) => setSummaryMaxWords(Number(e.target.value))}
              disabled={busy || active}
              title={IN_PROGRESS_TITLE}
            >
              {[30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map((n) => (
                <option key={n} value={n}>
                  ≤ {n} words
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="gen-notes">Notes for the draft (optional)</Label>
          <Textarea
            id="gen-notes"
            value={notes}
            maxLength={MAX_NOTES}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. emphasize backend and Kubernetes work"
            disabled={busy || active}
            title={IN_PROGRESS_TITLE}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy || active} title={IN_PROGRESS_TITLE} onClick={() => void generate("cv")}>
            {busy ? "Starting…" : active ? "Generating…" : content && !isLetterContent(content) ? "Regenerate CV" : "Generate CV"}
          </Button>
          <Button variant="outline" disabled={busy || active} title={IN_PROGRESS_TITLE} onClick={() => void generate("cover_letter")}>
            {content && isLetterContent(content) ? "Regenerate cover letter" : "Generate cover letter"}
          </Button>
          {error && (
            <span className="text-sm text-red-600">
              {error.code && <span className="mr-2 font-mono text-xs uppercase text-red-400">{error.code}</span>}
              {error.message}
              {error.action && <span className="block font-medium">{error.action}</span>}
            </span>
          )}
        </div>

        {job?.notice === "stale-analysis" && (
          <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-800">
            Some match evidence no longer resolves against the pinned profile snapshot — those entries
            were skipped. Re-running the match would improve tailoring.
          </p>
        )}
        {job?.status === "failed" && job.statusError && (
          <div className="space-y-1 rounded-md bg-red-50 p-2 text-sm text-red-700">
            <p>
              {describeError(job.statusError).code && (
                <span className="mr-2 font-mono text-xs uppercase text-red-500">{describeError(job.statusError).code}</span>
              )}
              {describeError(job.statusError).message}
            </p>
            {describeError(job.statusError).action && (
              <p className="font-medium">{describeError(job.statusError).action}</p>
            )}
          </div>
        )}

        {firstPollPending && <p className="text-sm text-neutral-500">Loading document…</p>}

        {content && document?.version && (
          <div className="space-y-3 border-t border-neutral-200 pt-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Version {document.version.version}</span>
              <span className="text-neutral-500">
                pinned profile v{job?.profileVersion} · attempt {job?.attempt}
              </span>
              <Badge tone={document.summary.warnings > 0 ? "warning" : "default"}>
                {document.summary.warnings} warnings
              </Badge>
            </div>
            {!isLetterContent(content) && content.skills.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs uppercase tracking-wide text-neutral-400">Skills</span>
                {content.skills.map((s) => (
                  <Badge key={s} tone="info">{s}</Badge>
                ))}
              </div>
            )}
            {!isLetterContent(content) && content.summary && (
              <p className="text-sm text-neutral-600">{content.summary}</p>
            )}
            {content && !isLetterContent(content) && (
              <SelectionView selection={document.version.selection} evidenceById={evidenceById} />
            )}
            {jobId && (
              <div className="border-t border-neutral-200 pt-3">
                <OmissionsList
                  jobId={jobId}
                  omissions={content.omissions}
                  onRestored={() => void refresh(jobId)}
                  onRegenerate={() => void generate()}
                  regenerating={busy || active}
                  conflictMessage={budgetConflict}
                />
              </div>
            )}
            <div className="space-y-2 border-t border-neutral-200 pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Downloads</p>
              <div className="flex flex-wrap items-center gap-2">
                {(isLetterContent(content) ? (["pdf", "txt"] as const) : (["pdf", "docx"] as const)).map((format) => {
                  const reason = downloadDisabledReason(format);
                  return document.downloadable[format] ? (
                    <a
                      key={format}
                      href={`/api/generations/${jobId}/download?format=${format}`}
                      download
                      className={cn(
                        "inline-flex h-8 items-center justify-center rounded-md border border-neutral-300",
                        "bg-white px-3 text-sm font-medium transition-colors hover:bg-neutral-100",
                      )}
                    >
                      Download {format.toUpperCase()} ({isLetterContent(content) ? "letter" : "cv"}-v
                      {document.currentVersion}.{format})
                    </a>
                  ) : (
                    <Button key={format} size="sm" variant="outline" disabled title={reason}>
                      {format.toUpperCase()} — {reason}
                    </Button>
                  );
                })}
                {isLetterContent(content) && (
                  <Button size="sm" variant="outline" disabled={!document.downloadable.txt} onClick={() => void copyLetterText()}>
                    {copied ? "Copied!" : "Copy as plain text"}
                  </Button>
                )}
              </div>
              <p className="text-xs text-neutral-500">
                {isLetterContent(content)
                  ? "The letter PDF is gate-verified; plain text is for pasting into application forms."
                  : "PDF downloads are gate-verified (extraction-checked); DOCX is best-effort."}
              </p>
              {gateFailed && extraction && (
                <div className="space-y-1 rounded-md bg-red-50 p-2 text-xs text-red-700">
                  <p className="font-medium">
                    PDF export failed the extraction gate — no file was stored. Regenerate to retry.
                  </p>
                  <p>
                    Level 1 (structure):{" "}
                    {extraction.level1.elements.filter((e) => e.found).length}/{extraction.level1.elements.length}{" "}
                    elements recovered · Level 2 (blocks):{" "}
                    {extraction.level2.blocks.filter((b) => b.ok).length}/{extraction.level2.blocks.length} blocks ≥{" "}
                    {Math.round(extraction.level2.threshold * 100)}% word recovery
                  </p>
                  {extraction.level1.elements.some((e) => !e.found) && (
                    <p>
                      Missing:{" "}
                      {extraction.level1.elements
                        .filter((e) => !e.found)
                        .map((e) => e.element)
                        .slice(0, 8)
                        .join(", ")}
                    </p>
                  )}
                </div>
              )}
            </div>
            {document.version.validationReport && document.version.validationReport.summary.warnings > 0 && (
              <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                <p className="font-medium">Draft notes ({document.version.validationReport.summary.warnings})</p>
                <ul className="list-disc pl-5">
                  {document.version.validationReport.flags.map((f, i) => (
                    <li key={`${f.claim}-${i}`}>
                      <span className="font-mono text-[10px] uppercase">{f.code}</span>{" "}
                      {FLAG_EXPLANATIONS[f.code] ?? f.claim}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="space-y-1">
              {rows.map((row) => {
                const open = openClaim === row.claimId;
                return (
                  <li key={row.claimId} className="rounded-md border border-neutral-200">
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 px-3 py-2 text-left"
                      onClick={() => setOpenClaim(open ? null : row.claimId)}
                      aria-expanded={open}
                    >
                      <span className="mt-0.5 text-xs text-neutral-400">{open ? "▾" : "▸"}</span>
                      <span className="flex-1 text-sm">{row.text || <em className="text-neutral-400">(empty)</em>}</span>
                      <Badge>{row.group}</Badge>
                    </button>
                    {open && (
                      <div className="space-y-1 border-t border-neutral-100 px-3 py-2">
                        <p className="font-mono text-[10px] uppercase tracking-wide text-neutral-400">
                          claim {row.claimId}
                        </p>
                        {row.rationale && <p className="text-xs text-neutral-500">{row.rationale}</p>}
                        <p className="text-xs font-medium text-neutral-600">Evidence</p>
                        {row.evidenceIds.length === 0 ? (
                          <p className="text-xs text-neutral-400">no evidence refs</p>
                        ) : (
                          <ul className="list-disc pl-5 text-xs text-neutral-600">
                            {row.evidenceIds.map((id) => {
                              const ref = evidenceById.get(id);
                              return (
                                <li key={id}>
                                  <span className="font-mono text-[10px] uppercase text-neutral-400">
                                    [{ref?.type ?? "ref"}]
                                  </span>{" "}
                                  {ref ? ref.snippet : id}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
