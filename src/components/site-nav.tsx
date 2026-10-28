"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * Top navigation for the subpages. Signed-in identity comes from
 * /api/auth/session (specs/008 US1) so this works identically from server- and
 * client-rendered pages without prop plumbing.
 */
export function SiteNav() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled) setEmail(body?.user?.email ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const linkCls = "text-sm text-neutral-600 hover:text-neutral-900 hover:underline underline-offset-4";
  return (
    <nav aria-label="Site" className="flex flex-wrap items-center gap-4">
      <Link href="/" className="text-sm font-medium underline underline-offset-4 hover:text-neutral-600">
        ← Home
      </Link>
      <Link href="/upload" className={linkCls}>
        Upload
      </Link>
      <Link href="/profile" className={linkCls}>
        Profile
      </Link>
      <Link href="/jobs" className={linkCls}>
        Jobs
      </Link>
      <Link href="/settings" className={linkCls}>
        Settings
      </Link>
      <span className="ml-auto flex items-center gap-3">
        {email && <span className="text-sm text-neutral-500">{email}</span>}
        <button
          type="button"
          onClick={signOut}
          className="text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:underline underline-offset-4"
        >
          Sign out
        </button>
      </span>
    </nav>
  );
}
