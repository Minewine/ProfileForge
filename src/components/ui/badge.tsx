import { cn } from "@/lib/utils";

type Tone = "default" | "warning" | "danger" | "success" | "info";

const tones: Record<Tone, string> = {
  default: "bg-neutral-100 text-neutral-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  success: "bg-green-100 text-green-800",
  info: "bg-blue-100 text-blue-800",
};

export function Badge({
  tone = "default",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
