import { cn } from "@/lib/utils";

export function Card({
  className,
  children,
  ...rest
}: { className?: string; children: React.ReactNode } & React.ComponentProps<"div">) {
  return (
    <div className={cn("rounded-lg border border-neutral-200 bg-white shadow-sm", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("border-b border-neutral-200 px-4 py-3", className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h3 className={cn("text-sm font-semibold text-neutral-900", className)}>{children}</h3>;
}

export function CardContent({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-4 py-3", className)}>{children}</div>;
}
