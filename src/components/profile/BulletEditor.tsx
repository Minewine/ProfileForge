"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ProvenanceBadge } from "@/components/profile/ProvenanceBadge";

export type BulletData = {
  id?: string;
  text: string;
  provenance?: string;
  reviewFlag?: string | null;
  containmentOk?: boolean | null;
};

/** A bullet row in the working list. Persisted bullets keep their server id as
 *  uid; drafts get a local uid so the DOM node (and focus) survives the
 *  draft→persisted transition after the first save. `syncedText` is the text
 *  as of the last refetch — a row whose text differs from it has unsaved local
 *  edits that reconciliation must not clobber (contract-editor-ui). */
type Item = BulletData & { uid: string; syncedText: string };

const freshUid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `draft-${Math.random()}`;

/**
 * Edits an entry's bullets. "+ Bullet" appends a local draft with no network
 * call; a draft joins the upstream payload (and persists) once it has text —
 * an empty draft is never sent. All edits compose through a working copy of
 * the list, so consecutive rapid edits to different bullets accumulate instead
 * of overwriting each other (FR-020, research D3/D9).
 */
export function BulletEditor({
  bullets,
  onChange,
  canConfirm,
}: {
  bullets: BulletData[];
  onChange: (bullets: BulletData[]) => void;
  canConfirm: boolean;
}) {
  const [list, setList] = useState<Item[]>(() =>
    bullets.map((b) => ({ ...b, uid: b.id ?? freshUid(), syncedText: b.text })),
  );
  const [seenBullets, setSeenBullets] = useState(bullets);

  // Reconcile when refetched props arrive: rows adopt the uid of the local
  // item they came from (a saved draft keeps its node); rows with unsaved
  // local edits keep their newer text; unsaved non-empty drafts (e.g. after a
  // failed save) stay editable; empty drafts are dropped.
  if (bullets !== seenBullets) {
    setSeenBullets(bullets);
    setList((prev) => reconcile(prev, bullets));
  }

  function emit(next: Item[]) {
    onChange(
      next
        .filter((it) => it.id || it.text.trim() !== "")
        .map((it) => ({
          id: it.id,
          text: it.text,
          provenance: it.provenance,
          reviewFlag: it.reviewFlag,
          containmentOk: it.containmentOk,
        })),
    );
  }

  function updateText(index: number, text: string) {
    const next = list.map((it, j) => (j === index ? { ...it, text } : it));
    setList(next);
    emit(next);
  }

  function removeAt(index: number) {
    const item = list[index]!;
    const next = list.filter((_, j) => j !== index);
    setList(next);
    if (item.id || item.text.trim() !== "") emit(next);
  }

  function confirmAt(index: number) {
    const next = list.map((it, j) => (j === index ? { ...it, provenance: "user_confirmed" } : it));
    setList(next);
    emit(next);
  }

  return (
    <div className="space-y-2">
      {list.map((b, i) => (
        <div key={b.uid} className="flex items-start gap-2">
          <Textarea
            value={b.text}
            onChange={(e) => updateText(i, e.target.value)}
            className={b.reviewFlag ? "border-amber-300" : ""}
            data-testid={b.id ? `bullet-${b.id}` : undefined}
          />
          <div className="flex flex-col items-end gap-1">
            <ProvenanceBadge info={b} compact />
            {b.reviewFlag && canConfirm && (
              <Button size="sm" variant="outline" onClick={() => confirmAt(i)}>
                Confirm
              </Button>
            )}
            <Button size="sm" variant="ghost" aria-label="Remove bullet" onClick={() => removeAt(i)}>
              ✕
            </Button>
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => setList([...list, { uid: freshUid(), text: "", syncedText: "" }])}
      >
        + Bullet
      </Button>
    </div>
  );
}

/** Adopt uids from the working list so rows keep their DOM identity across a
 *  save+refetch: match persisted bullets by id, and a saved draft by its text.
 *  A persisted row with unsaved local edits (typing during the save→refetch
 *  window) keeps its newer text instead of the refetched one. */
function reconcile(prev: Item[], props: BulletData[]): Item[] {
  const pool = [...prev];
  const items: Item[] = props.map((b) => {
    const idx = pool.findIndex((it) => (b.id && it.id === b.id) || (!it.id && it.text === b.text));
    if (idx < 0) return { ...b, uid: freshUid(), syncedText: b.text };
    const local = pool[idx]!;
    pool.splice(idx, 1);
    const hasUnsavedEdits = Boolean(local.id) && local.text !== local.syncedText;
    return { ...b, text: hasUnsavedEdits ? local.text : b.text, uid: local.uid, syncedText: b.text };
  });
  const unsavedDrafts = pool.filter((it) => !it.id && it.text.trim() !== "");
  return [...items, ...unsavedDrafts];
}
