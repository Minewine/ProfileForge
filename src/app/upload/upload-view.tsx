"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SiteNav } from "@/components/site-nav";
import { Select } from "@/components/ui/select";
import { describeError, type DescribedError } from "@/lib/client-messages";

type UploadResult = {
  sourceDocumentId: string;
  detectedLanguage: "fr" | "en";
  languageLowConfidence: boolean;
  pageCount: number | null;
  paragraphCount: number | null;
  charCount: number;
  requiresPartialParseConfirmation: boolean;
  parseStatus: string;
};

type ParseResult = {
  parseStatus: string;
  draft: {
    basics?: { name?: string | null } | null;
    experience: Array<{ company: string; title: string; startDate: string | null; endDate: string | null; bullets: Array<{ text: string; reviewFlag?: string | null; containmentOk?: boolean | null }> }>;
    skills: Array<{ name: string }>;
  };
  flags: Array<{ code: string; detail: string }>;
  partial?: boolean;
  omittedPages?: number[];
  usage?: { costUsd: number };
};

type ApiErrorBody = { error?: { code: string; message: string } };

async function readError(res: Response): Promise<DescribedError> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  if (body?.error) return describeError(body.error.code, body.error.message);
  return { code: null, message: `Request failed (${res.status}).`, action: null };
}

export function UploadView() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [language, setLanguage] = useState<"fr" | "en">("en");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [imported, setImported] = useState<{ version: number; preservedUserEntries: number } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);

  async function handleUpload() {
    if (!file) return;
    setError(null);
    setParsed(null);
    setImported(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/cv/upload", { method: "POST", body: form });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    const body = (await res.json()) as UploadResult;
    setUpload(body);
    setLanguage(body.detectedLanguage);
  }

  async function correctLanguage(lang: "fr" | "en") {
    if (!upload || lang === language) return;
    setLanguage(lang);
    const res = await fetch(`/api/cv/${upload.sourceDocumentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: lang }),
    });
    if (!res.ok) setError(await readError(res));
  }

  async function runParse(confirmPartial = false) {
    if (!upload) return;
    setParsing(true);
    setError(null);
    try {
      const res = await fetch(`/api/cv/${upload.sourceDocumentId}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmPartial ? { confirmPartial: true } : {}),
      });
      if (res.status === 422) {
        const body = (await res.json()) as ApiErrorBody;
        if (body.error?.code === "CONFIRMATION_REQUIRED") {
          setConfirmDialog(true);
          return;
        }
      }
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setParsed((await res.json()) as ParseResult);
    } finally {
      setParsing(false);
    }
  }

  async function runImport(mode: "replace_parsed" | "merge") {
    if (!upload) return;
    setError(null);
    const res = await fetch("/api/profile/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceDocumentId: upload.sourceDocumentId, mode }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setImported(await res.json());
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <SiteNav />
      <h1 className="text-2xl font-semibold">Upload your CV</h1>
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          <p>
            {error.code && <span className="mr-2 font-mono text-xs uppercase text-red-500">{error.code}</span>}
            {error.message}
          </p>
          {error.action && <p className="mt-1 font-medium">{error.action}</p>}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>1. File (PDF or DOCX, ≤ 10 MB, French or English)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          <Button onClick={handleUpload} disabled={!file}>
            Upload & extract
          </Button>
        </CardContent>
      </Card>

      {upload && (
        <Card>
          <CardHeader>
            <CardTitle>2. Detected language</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-3">
              <Select
                value={language}
                onChange={(e) => void correctLanguage(e.target.value as "fr" | "en")}
                className="w-32"
                aria-label="Detected language"
              >
                <option value="en">English</option>
                <option value="fr">Français</option>
              </Select>
              {upload.languageLowConfidence && <Badge tone="warning">Low confidence — please verify</Badge>}
              {upload.requiresPartialParseConfirmation && (
                <Badge tone="warning">Long CV — partial parse will apply</Badge>
              )}
            </div>
            <p className="text-xs text-neutral-500">
              {upload.pageCount ? `${upload.pageCount} pages` : `${upload.paragraphCount} paragraphs`} ·{" "}
              {upload.charCount.toLocaleString()} characters extracted
            </p>
            <div className="flex gap-2 pt-2">
              <Button onClick={() => void runParse(false)} disabled={parsing}>
                {parsing ? "Parsing…" : "Parse with AI"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {parsed && (
        <Card>
          <CardHeader>
            <CardTitle>
              3. Draft review {parsed.partial && <Badge tone="warning">Partial — pages {parsed.omittedPages?.join(", ")} omitted</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-neutral-700">{parsed.draft.basics?.name ?? "No name detected"}</p>
            {parsed.flags.length === 0 ? (
              <Badge tone="success">No review flags</Badge>
            ) : (
              <ul className="space-y-1 text-sm">
                {parsed.flags.slice(0, 8).map((f, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Badge tone={f.code === "containment_failed" ? "danger" : "warning"}>{f.code}</Badge>
                    <span className="text-neutral-600">{f.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <ul className="space-y-2 text-sm">
              {parsed.draft.experience.map((e, i) => (
                <li key={i}>
                  <span className="font-medium">
                    {e.title} — {e.company}
                  </span>{" "}
                  <span className="text-neutral-500">
                    {e.startDate ?? "?"} → {e.endDate ?? "?"}
                  </span>
                  <ul className="ml-4 list-disc">
                    {e.bullets.map((b, j) => (
                      <li key={j} className={b.reviewFlag ? "text-amber-700" : "text-neutral-700"}>
                        {b.text} {b.reviewFlag && <Badge tone="warning">{b.reviewFlag}</Badge>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="flex gap-2 pt-2">
              <Button onClick={() => void runImport("replace_parsed")}>Import (replace parsed)</Button>
              <Button variant="outline" onClick={() => void runImport("merge")}>
                Import (merge)
              </Button>
              <Button variant="ghost" onClick={() => void runParse(false)}>
                Re-parse
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {imported && (
        <Card>
          <CardContent className="flex items-center justify-between pt-4">
            <div>
              <p className="text-sm font-medium text-green-700">Imported into your profile.</p>
              <p className="text-xs text-neutral-500">
                Profile version {imported.version} · {imported.preservedUserEntries} user-entered entries preserved
              </p>
            </div>
            <Button onClick={() => router.push("/profile")}>Open profile editor</Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmDialog} onClose={() => setConfirmDialog(false)} title="Confirm partial parse">
        <p className="mb-4 text-sm text-neutral-700">
          This CV is longer than 10 pages. Only the first 10 pages will be parsed — the rest will be
          omitted. Nothing is truncated silently, so we need your explicit confirmation.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmDialog(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setConfirmDialog(false);
              void runParse(true);
            }}
          >
            Parse first 10 pages
          </Button>
        </div>
      </Dialog>
    </main>
  );
}
