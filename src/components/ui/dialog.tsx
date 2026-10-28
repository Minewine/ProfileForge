"use client";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={cn("max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg bg-white p-4 shadow-xl")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold text-neutral-900">{title}</h2>
        {children}
      </div>
    </div>
  );
}
