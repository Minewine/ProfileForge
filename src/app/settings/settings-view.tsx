"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SiteNav } from "@/components/site-nav";

type SettingsDto = {
  keyConfigured: boolean;
  keySource: "env" | "db" | null;
  keyHint: string | null;
  modelEconomy: string;
  modelPremium: string;
  costCapUsd: number;
  usage: Array<{ runId: string; task: string; model: string; costUsd: number; createdAt: string }>;
};

type ModelInfo = { id: string; name?: string; structuredOutputs: boolean };

export function SettingsView() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [newKey, setNewKey] = useState("");
  const [modelEconomy, setModelEconomy] = useState("");
  const [modelPremium, setModelPremium] = useState("");
  const [costCap, setCostCap] = useState("0.50");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings");
    const dto = (await res.json()) as SettingsDto;
    setSettings(dto);
    setModelEconomy(dto.modelEconomy);
    setModelPremium(dto.modelPremium);
    setCostCap(String(dto.costCapUsd));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState runs after an awaited fetch, not synchronously
    void load();
  }, [load]);

  async function saveKey() {
    setMessage(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openRouterKey: newKey }),
    });
    const body = await res.json();
    if (res.ok) {
      const keyWarnings = (body?.warnings as Array<{ message: string }> | undefined) ?? [];
      const label = body?.keyValidation?.label ? ` (${body.keyValidation.label})` : "";
      setNewKey("");
      setMessage({
        ok: true,
        text: keyWarnings.length
          ? `Key saved${label}. Note: ${keyWarnings.map((w) => w.message).join(" ")}`
          : `Key validated and saved${label} — shown masked from now on.`,
      });
      await load();
    } else {
      setMessage({ ok: false, text: body?.error?.message ?? "Failed to save key." });
    }
  }

  async function saveModels() {
    setMessage(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelEconomy,
        modelPremium,
        costCapUsd: Number.parseFloat(costCap),
      }),
    });
    const body = await res.json();
    if (res.ok) {
      const modelWarnings = (body?.warnings as Array<{ message: string }> | undefined) ?? [];
      setMessage({
        ok: true,
        text: modelWarnings.length
          ? `Model settings saved. Note: ${modelWarnings.map((w) => w.message).join(" ")}`
          : "Model settings saved.",
      });
      await load();
    } else {
      setMessage({ ok: false, text: body?.error?.message ?? "Failed to save models." });
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <SiteNav />
      <h1 className="text-2xl font-semibold">Settings</h1>
      {message && (
        <p className={message.ok ? "text-sm text-green-700" : "text-sm text-red-700"}>{message.text}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>OpenRouter API key</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-neutral-600">
            {settings?.keyConfigured
              ? `Configured (${settings.keySource === "env" ? "environment variable" : "stored encrypted"}) — ${settings.keyHint ?? ""}`
              : "No key configured."}
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="sk-or-v1-…"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <Button onClick={saveKey} disabled={newKey.length < 20}>
              Validate & save
            </Button>
          </div>
          <p className="text-xs text-neutral-500">
            The key is validated against OpenRouter before saving, stored encrypted, and never displayed
            in full again.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Models & cost cap</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ModelPicker
            fieldId="economy"
            label="Economy model (parse / extract / validate)"
            value={modelEconomy}
            onChange={setModelEconomy}
          />
          <ModelPicker
            fieldId="premium"
            label="Premium model (generation — later slices)"
            value={modelPremium}
            onChange={setModelPremium}
          />
          <div className="space-y-1">
            <Label htmlFor="cap">Per-run cost cap (USD)</Label>
            <Input
              id="cap"
              type="number"
              step="0.05"
              min="0.05"
              max="100"
              value={costCap}
              onChange={(e) => setCostCap(e.target.value)}
            />
          </div>
          <Button onClick={saveModels}>Save</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent AI usage</CardTitle>
        </CardHeader>
        <CardContent>
          {settings?.usage?.length ? (
            <ul className="space-y-1 text-sm">
              {settings.usage.map((u, i) => (
                <li key={i} className="flex justify-between text-neutral-700">
                  <span>
                    {u.task} · {u.model}
                  </span>
                  <span>${u.costUsd.toFixed(4)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">No AI calls yet.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function ModelPicker({
  fieldId,
  label,
  value,
  onChange,
}: {
  fieldId: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [results, setResults] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const res = await fetch(`/api/settings/models?q=${encodeURIComponent(value)}`);
      if (res.ok) {
        const body = (await res.json()) as { models: ModelInfo[] };
        setResults(body.models);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value]);

  const selected = results.find((m) => m.id === value);

  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="relative">
        <Input
          id={fieldId}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search OpenRouter models…"
          autoComplete="off"
        />
        {open && results.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg">
            {results.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-neutral-100"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">
                    <span className="font-mono text-xs">{m.id}</span>
                    {m.name && <span className="ml-2 text-neutral-500">{m.name}</span>}
                  </span>
                  <Badge tone={m.structuredOutputs ? "success" : "default"}>
                    {m.structuredOutputs ? "structured ✓" : "structured ?"}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {value && (
        <p className="text-xs text-neutral-500">
          {selected
            ? selected.structuredOutputs
              ? "This model advertises structured-output support."
              : "This model does not advertise structured-output support — it will run in prompt-only JSON mode (schema enforced locally, with repair retries)."
            : "Custom id — must exist on OpenRouter."}
        </p>
      )}
    </div>
  );
}
