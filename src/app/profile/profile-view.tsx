"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BulletEditor, type BulletData } from "@/components/profile/BulletEditor";
import { MergeOrKeepDialog } from "@/components/profile/MergeOrKeepDialog";
import { LowConfidenceHighlight, ProvenanceBadge } from "@/components/profile/ProvenanceBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SiteNav } from "@/components/site-nav";

type Entry = Record<string, unknown> & {
  id: string;
  provenance: string;
  reviewFlag?: string | null;
  sourceLocator?: { page?: number; paragraphIndex?: number } | null;
  bullets?: Array<BulletData & { containmentOk?: boolean | null }>;
};

type ProfileDto = {
  id: string;
  version: number;
  language: "fr" | "en";
  basics: Record<string, string | string[] | null> | null;
  experience: Entry[];
  education: Entry[];
  skills: Entry[];
  languages: Entry[];
  projects: Entry[];
  certifications: Entry[];
  lowConfidenceCount: number;
};

type VersionInfo = { version: number; cause: string; createdAt: string };
type ClaimFlag = {
  code: string;
  claim: string;
  severity: "blocker" | "warning";
  resolution?: string | null;
};

const SECTIONS = [
  { key: "experience", label: "Experience" },
  { key: "education", label: "Education" },
  { key: "skills", label: "Skills" },
  { key: "languages", label: "Languages" },
  { key: "projects", label: "Projects" },
  { key: "certifications", label: "Certifications" },
] as const;

const FIELDS: Record<string, Array<{ key: string; label: string; area?: boolean; placeholder?: string }>> = {
  experience: [
    { key: "company", label: "Company" },
    { key: "title", label: "Title" },
    { key: "location", label: "Location" },
    { key: "startDate", label: "Start", placeholder: "YYYY-MM" },
    { key: "endDate", label: "End", placeholder: "YYYY-MM or present" },
    { key: "skillsUsed", label: "Skills used", placeholder: "comma-separated" },
  ],
  education: [
    { key: "institution", label: "Institution" },
    { key: "degree", label: "Degree" },
    { key: "field", label: "Field" },
    { key: "startDate", label: "Start", placeholder: "YYYY-MM" },
    { key: "endDate", label: "End", placeholder: "YYYY-MM or present" },
    { key: "grade", label: "Grade" },
  ],
  skills: [
    { key: "name", label: "Name" },
    { key: "category", label: "Category" },
    { key: "level", label: "Level (user-stated)" },
    { key: "aliases", label: "Approved aliases", placeholder: "comma-separated" },
  ],
  languages: [
    { key: "name", label: "Language" },
    { key: "proficiency", label: "Proficiency" },
  ],
  projects: [
    { key: "name", label: "Project" },
    { key: "description", label: "Description", area: true },
    { key: "link", label: "Link" },
    { key: "startDate", label: "Start", placeholder: "YYYY-MM" },
    { key: "endDate", label: "End", placeholder: "YYYY-MM or present" },
  ],
  certifications: [
    { key: "title", label: "Certification" },
    { key: "issuer", label: "Issuer" },
    { key: "issueDate", label: "Issued", placeholder: "YYYY-MM" },
  ],
};

const AUTOSAVE_DELAY_MS = 800;

/** Placeholder payload per section so "+ Add" always satisfies the create schemas (research D4). */
const ADD_PLACEHOLDERS: Record<string, Record<string, string>> = {
  experience: { company: "New role", title: "Title" },
  education: { institution: "New education" },
  skills: { name: "New skill" },
  languages: { name: "New language" },
  projects: { name: "New project" },
  certifications: { title: "New certification" },
};

/** Optional scalar entry fields: an emptied input clears the field (null), per contracts/api.md. */
const OPTIONAL_SCALARS = new Set([
  "location",
  "startDate",
  "endDate",
  "degree",
  "field",
  "grade",
  "category",
  "level",
  "proficiency",
  "description",
  "link",
  "issuer",
  "issueDate",
]);

export function ProfileEditorView() {
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [claims, setClaims] = useState<{ summary: { blockers: number; warnings: number }; flags: ClaimFlag[] } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string[]>([]);
  const [dupSkill, setDupSkill] = useState<string | null>(null);
  // The entry "+ Add" just created — its first field takes focus after the
  // post-add refetch (contract-editor-ui).
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Latest server state, for building error labels at save time (closures in
  // `schedule` would otherwise capture a stale render).
  const profileRef = useRef<ProfileDto | null>(null);
  // Pending basics edits are merged before the debounced flush so two quick
  // edits to different fields cannot overwrite each other (research D8).
  const pendingBasics = useRef<Record<string, unknown>>({});
  const lastBasicsSent = useRef<Record<string, unknown>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/profile");
    const body = await res.json();
    setProfile(body.profile as ProfileDto);
    profileRef.current = body.profile as ProfileDto;
    lastBasicsSent.current = (body.profile as ProfileDto).basics ?? {};
  }, []);

  const loadVersions = useCallback(async () => {
    const res = await fetch("/api/profile/versions");
    const body = await res.json();
    setVersions(body.versions as VersionInfo[]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState runs after an awaited fetch
    void load();
    void loadVersions();
  }, [load, loadVersions]);

  function schedule(key: string, fn: () => unknown) {
    const existing = timers.current.get(key);
    if (existing) clearTimeout(existing);
    timers.current.set(
      key,
      setTimeout(() => {
        void fn();
      }, AUTOSAVE_DELAY_MS),
    );
  }

  function beginSave() {
    setStatus("Saving…");
    setError(null);
    setWarning([]);
  }

  function showWarnings(warnings: Array<{ code: string; message: string }> | undefined) {
    if (warnings && warnings.length > 0) {
      setWarning(warnings.map((w) => `${w.code}: ${w.message}`));
    }
  }

  /** Cancel any pending autosaves for an entry that is about to disappear so a
   *  stale save firing after DELETE cannot 404 into a spurious error banner. */
  function cancelEntryTimers(section: string, id: string) {
    const prefix = `${section}-${id}-`;
    for (const [key, timer] of [...timers.current]) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        timers.current.delete(key);
      }
    }
  }

  function entryLabel(section: string, id: string): string {
    const list = (profileRef.current as unknown as Record<string, Entry[]> | null)?.[section];
    const entry = list?.find((e) => e.id === id);
    const rawTitle = entry ? (entry.company ?? entry.institution ?? entry.name ?? entry.title) : undefined;
    const sectionLabel = SECTIONS.find((s) => s.key === section)?.label ?? section;
    return typeof rawTitle === "string" ? `${sectionLabel} at ${rawTitle}` : sectionLabel;
  }

  function sectionLabel(section: string): string {
    return SECTIONS.find((s) => s.key === section)?.label ?? section;
  }

  function flushBasics() {
    const pending = Object.fromEntries(
      Object.entries(pendingBasics.current).map(([k, v]) => [k, k !== "name" && v === "" ? null : v]),
    );
    pendingBasics.current = {};
    void patchProfile({
      basics: {
        ...lastBasicsSent.current,
        name: (lastBasicsSent.current.name as string) ?? "Your name",
        ...pending,
      },
    }).then((ok) => {
      // A failed flush keeps its edits pending so the next keystroke retries them.
      if (!ok) pendingBasics.current = { ...pending, ...pendingBasics.current };
    });
  }

  async function patchProfile(patch: Record<string, unknown>): Promise<boolean> {
    beginSave();
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const body = (await res.json()) as { version: number };
        setStatus(`Saved · v${body.version}`);
        await load();
        return true;
      }
      setError(describeSaveError("Profile basics", await res.json().catch(() => null)));
      setStatus("Failed");
      return false;
    } catch {
      setError("Profile basics — could not reach the server");
      setStatus("Failed");
      return false;
    }
  }

  async function saveEntry(section: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
    beginSave();
    try {
      const res = await fetch(`/api/profile/entries/${section}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.status === 409) {
        // Renaming a skill onto an existing name (contract-editor-ui).
        const body = await res.json();
        setDupSkill(body?.error?.details?.existingName ?? "existing skill");
        setStatus(null);
        setError(null);
        return false;
      }
      if (res.ok) {
        const body = (await res.json()) as { version: number; warnings?: Array<{ code: string; message: string }> };
        setStatus(`Saved · v${body.version}`);
        showWarnings(body.warnings);
        await load();
        return true;
      }
      setError(describeSaveError(entryLabel(section, id), await res.json().catch(() => null)));
      setStatus("Failed");
      return false;
    } catch {
      setError(`${entryLabel(section, id)} — could not reach the server`);
      setStatus("Failed");
      return false;
    }
  }

  async function addEntry(section: string) {
    beginSave();
    try {
      const res = await fetch(`/api/profile/entries/${section}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ADD_PLACEHOLDERS[section] ?? {}),
      });
      if (res.status === 409) {
        const body = await res.json();
        setDupSkill(body?.error?.details?.existingName ?? "existing skill");
        setStatus(null);
        setError(null);
        return;
      }
      if (res.ok) {
        const body = (await res.json()) as { id: string; version: number; warnings?: Array<{ code: string; message: string }> };
        setStatus(`Saved · v${body.version}`);
        setJustAdded(body.id);
        showWarnings(body.warnings);
        await load();
        await loadVersions();
        return;
      }
      setError(describeSaveError(sectionLabel(section), await res.json().catch(() => null)));
      setStatus("Failed");
    } catch {
      setError(`${sectionLabel(section)} — could not reach the server`);
      setStatus("Failed");
    }
  }

  async function deleteEntry(section: string, id: string) {
    if (!window.confirm("Delete this entry?")) return;
    cancelEntryTimers(section, id);
    beginSave();
    try {
      const res = await fetch(`/api/profile/entries/${section}/${id}`, { method: "DELETE" });
      if (res.ok) {
        const body = (await res.json()) as { version: number };
        setStatus(`Deleted · v${body.version}`);
        await load();
        await loadVersions();
        return;
      }
      setError(describeSaveError(entryLabel(section, id), await res.json().catch(() => null)));
      setStatus("Failed");
    } catch {
      setError(`${entryLabel(section, id)} — could not reach the server`);
      setStatus("Failed");
    }
  }

  async function confirmEntry(section: string, id: string) {
    await saveEntry(section, id, { provenance: "user_confirmed" });
  }

  async function restore(version: number) {
    beginSave();
    try {
      const res = await fetch(`/api/profile/versions/${version}/restore`, { method: "POST" });
      if (res.ok) {
        setStatus(`Restored v${version}`);
        await load();
        await loadVersions();
        return;
      }
      setError(describeSaveError(`Version v${version}`, await res.json().catch(() => null)));
      setStatus("Failed");
    } catch {
      setError(`Version v${version} — could not reach the server`);
      setStatus("Failed");
    }
  }

  async function runClaims() {
    const res = await fetch("/api/validation/claims", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (res.ok) setClaims(await res.json());
  }

  if (!profile) return <main className="mx-auto max-w-3xl p-6">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <SiteNav />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Profile editor</h1>
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          {status && (
            <span data-testid="save-status">{status}</span>
          )}
          <Badge tone={profile.lowConfidenceCount > 0 ? "warning" : "success"}>
            {profile.lowConfidenceCount} review flags
          </Badge>
          <Badge>v{profile.version}</Badge>
        </div>
      </div>

      {(error || warning.length > 0) && (
        <div className="space-y-1">
          {error && <p data-testid="save-error" className="text-sm text-red-600">{error}</p>}
          {warning.length > 0 && (
            <div data-testid="save-warning" className="text-sm text-amber-600">
              {warning.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Basics & language</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          {(["name", "headline", "email", "phone", "location", "summary"] as const).map((f) => (
            <div key={f} className={f === "summary" ? "col-span-2 space-y-1" : "space-y-1"}>
              <Label htmlFor={`basics-${f}`}>{f}</Label>
              {f === "summary" ? (
                <Textarea
                  id={`basics-${f}`}
                  defaultValue={(profile.basics?.[f] as string) ?? ""}
                  onChange={(e) => {
                    pendingBasics.current[f] = e.target.value;
                    schedule("basics", flushBasics);
                  }}
                />
              ) : (
                <Input
                  id={`basics-${f}`}
                  defaultValue={(profile.basics?.[f] as string) ?? ""}
                  onChange={(e) => {
                    pendingBasics.current[f] = e.target.value;
                    schedule("basics", flushBasics);
                  }}
                />
              )}
            </div>
          ))}
          <div className="space-y-1">
            <Label htmlFor="basics-links">Links (one per line)</Label>
            <Textarea
              id="basics-links"
              defaultValue={(profile.basics?.links as string[] | undefined)?.join("\n") ?? ""}
              onChange={(e) => {
                pendingBasics.current.links = e.target.value
                  .split(/\n|,/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                schedule("basics", flushBasics);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="profile-language">Profile language</Label>
            <Select
              id="profile-language"
              value={profile.language}
              onChange={(e) => void patchProfile({ language: e.target.value })}
              className="w-36"
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      {SECTIONS.map(({ key, label }) => (
        <Card key={key} data-testid={`section-${key}`}>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>{label}</CardTitle>
            <Button size="sm" variant="outline" onClick={() => void addEntry(key)} data-testid={`add-${key}`}>
              + Add
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {profile[key].length === 0 && <p className="text-sm text-neutral-500">No entries yet.</p>}
            {profile[key].map((entry) => (
              <LowConfidenceHighlight key={entry.id} flagged={entry.reviewFlag != null} className="space-y-2 border border-neutral-200 rounded-md p-3" testId={`entry-${key}-${entry.id}`}>
                <div className="flex items-center justify-between">
                  <ProvenanceBadge info={entry} />
                  <div className="flex gap-1">
                    {entry.provenance === "imported" && entry.reviewFlag && (
                      <Button size="sm" variant="outline" onClick={() => void confirmEntry(key, entry.id)}>
                        Confirm
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void deleteEntry(key, entry.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {FIELDS[key].map((f) => (
                    <div key={f.key} className={f.area ? "col-span-2 space-y-1" : "space-y-1"}>
                      <Label className="text-xs" htmlFor={`entry-${key}-${entry.id}-${f.key}`}>
                        {f.label}
                      </Label>
                      {f.area ? (
                        <Textarea
                          id={`entry-${key}-${entry.id}-${f.key}`}
                          defaultValue={String(entry[f.key] ?? "")}
                          autoFocus={justAdded === entry.id && FIELDS[key][0]?.key === f.key}
                          onChange={(e) => {
                            const value = e.target.value;
                            schedule(`${key}-${entry.id}-${f.key}`, () =>
                              void saveEntry(key, entry.id, { [f.key]: parseInput(f.key, value) }),
                            );
                          }}
                        />
                      ) : (
                        <Input
                          id={`entry-${key}-${entry.id}-${f.key}`}
                          placeholder={f.placeholder}
                          defaultValue={fieldValue(entry[f.key])}
                          autoFocus={justAdded === entry.id && FIELDS[key][0]?.key === f.key}
                          onChange={(e) => {
                            const value = e.target.value;
                            schedule(`${key}-${entry.id}-${f.key}`, () => void saveEntry(key, entry.id, { [f.key]: parseInput(f.key, value) }));
                          }}
                        />
                      )}
                    </div>
                  ))}
                </div>
                {(key === "experience" || key === "projects") && (
                  <BulletEditor
                    bullets={entry.bullets ?? []}
                    onChange={(bullets) => {
                      schedule(`${key}-${entry.id}-bullets`, () => void saveEntry(key, entry.id, { bullets }));
                    }}
                    canConfirm={entry.provenance === "imported"}
                  />
                )}
              </LowConfidenceHighlight>
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Version history</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {versions.slice(0, 10).map((v) => (
              <li key={v.version} className="flex items-center justify-between" data-testid="version-row">
                <span className="text-neutral-700">
                  v{v.version} · {v.cause} · {new Date(v.createdAt).toLocaleString()}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void restore(v.version)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Claim validation</CardTitle>
          <Button size="sm" variant="outline" onClick={() => void runClaims()} data-testid="validate-claims">
            Validate claims
          </Button>
        </CardHeader>
        <CardContent>
          {claims ? (
            claims.flags.length === 0 ? (
              <p className="text-sm text-green-700">All claims are grounded in profile evidence.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm">
                  <Badge tone={claims.summary.blockers > 0 ? "danger" : "warning"}>
                    {claims.summary.blockers} blockers
                  </Badge>{" "}
                  <Badge tone="warning">{claims.summary.warnings} warnings</Badge>
                </p>
                <ul className="space-y-1 text-sm">
                  {claims.flags.slice(0, 12).map((f, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Badge tone={f.severity === "blocker" ? "danger" : "warning"}>{f.code}</Badge>
                      <span className="text-neutral-600">{f.claim}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <p className="text-sm text-neutral-500">
              Checks that every material claim links to profile evidence (provenance coverage + containment).
            </p>
          )}
        </CardContent>
      </Card>

      <MergeOrKeepDialog open={dupSkill !== null} existingName={dupSkill} onClose={() => setDupSkill(null)} />
    </main>
  );
}

function fieldValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  return v == null ? "" : String(v);
}

function parseInput(key: string, value: string): unknown {
  if (key === "skillsUsed" || key === "aliases") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (OPTIONAL_SCALARS.has(key) && value.trim() === "") return null;
  return value;
}

type ErrorBody = { error?: { code: string; message: string; details?: unknown } | null } | null;

/** `{Item label} — {reason}` from the API error envelope (contracts/editor-ui.md). */
function describeSaveError(label: string, body: ErrorBody): string {
  const details = body?.error?.details;
  if (Array.isArray(details) && details.length > 0) {
    const issues = details
      .map((d) => (typeof d === "object" && d !== null && "path" in d && "message" in d ? `${(d as { path: unknown }).path}: ${(d as { message: unknown }).message}` : String(d)))
      .join("; ");
    return `${label} — ${issues}`;
  }
  return `${label} — ${body?.error?.message ?? "could not reach the server"}`;
}
