import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ProvenanceInfo = {
  provenance?: string;
  reviewFlag?: string | null;
  containmentOk?: boolean | null;
  sourceLocator?: { page?: number; paragraphIndex?: number } | null;
};

/** Provenance + review-flag badge shown on every profile entry and bullet. */
export function ProvenanceBadge({ info, compact }: { info: ProvenanceInfo; compact?: boolean }) {
  const provenance = info.provenance ?? "user_entered";
  const label =
    provenance === "imported"
      ? `imported${info.sourceLocator?.page ? ` · p.${info.sourceLocator.page}` : info.sourceLocator?.paragraphIndex != null ? ` · ¶${info.sourceLocator.paragraphIndex}` : ""}`
      : info.provenance === "user_confirmed"
        ? "user-confirmed"
        : "user-entered";

  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={provenance === "imported" ? "info" : "default"}>{label}</Badge>
      {!compact && info.reviewFlag && (
        <Badge tone={info.reviewFlag === "containment_failed" ? "danger" : "warning"}>
          {info.reviewFlag}
        </Badge>
      )}
    </span>
  );
}

/** Wraps content that carries an unresolved review flag. */
export function LowConfidenceHighlight({
  flagged,
  children,
  className,
  testId,
}: {
  flagged: boolean;
  children: React.ReactNode;
  className?: string;
  /** Optional stable anchor for E2E selectors (additive, no behavior). */
  testId?: string;
}) {
  return (
    <div className={cn(flagged && "rounded-md border border-amber-300 bg-amber-50 p-2", className)} data-testid={testId}>
      {children}
    </div>
  );
}
