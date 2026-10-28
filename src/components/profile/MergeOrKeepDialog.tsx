"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/** Shown when creating a skill that duplicates an existing one (409 DUPLICATE_SKILL). */
export function MergeOrKeepDialog({
  open,
  existingName,
  onClose,
}: {
  open: boolean;
  existingName: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Duplicate skill">
      <p className="mb-4 text-sm text-neutral-700">
        A skill named <span className="font-medium">{existingName}</span> already exists in your
        profile (skill names are compared case- and accent-insensitively). Keep the existing entry,
        or edit your new skill&apos;s name and save again.
      </p>
      <div className="flex justify-end">
        <Button onClick={onClose}>Keep existing</Button>
      </div>
    </Dialog>
  );
}
