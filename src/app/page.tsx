import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/guard";
import { getProfile } from "@/lib/profile/repository";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <h1 className="text-3xl font-semibold">ProfileForge</h1>
      <p className="text-neutral-600">
        ATS-optimized, fact-checked CVs and cover letters — every claim traceable to your profile.
      </p>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/upload"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Upload a CV
        </Link>
        <Link
          href="/profile"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100"
        >
          Profile editor
        </Link>
        <Link
          href="/settings"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100"
        >
          Settings
        </Link>
      </div>

      <Suspense fallback={<div className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500">Loading profile status…</div>}>
        <ProfileStatus userId={user.id} />
      </Suspense>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/jobs"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Analyze a job description
        </Link>
      </div>
    </main>
  );
}

async function ProfileStatus({ userId }: { userId: string }) {
  const profile = await getProfile(userId);
  const awaitingDraft = await db.sourceDocument.findFirst({
    where: { userId, parseStatus: "parsed", importedAt: null },
    select: { originalFilename: true },
  });

  const counts = [
    ["Experience", profile.experience.length],
    ["Education", profile.education.length],
    ["Skills", profile.skills.length],
    ["Languages", profile.languages.length],
    ["Projects", profile.projects.length],
    ["Certifications", profile.certifications.length],
  ] as const;

  return (
    <div className="space-y-4">
      {awaitingDraft && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          A parsed CV draft (“{awaitingDraft.originalFilename}”) is waiting to be imported.{" "}
          <Link href="/upload" className="underline">
            Review it
          </Link>
          .
        </div>
      )}
      <div className="rounded-lg border border-neutral-200 p-4">
        <p className="mb-2 text-sm font-medium text-neutral-700">
          Profile status · v{profile.version} · {profile.language.toUpperCase()} ·{" "}
          {profile.lowConfidenceCount > 0 ? (
            <span className="text-amber-700">{profile.lowConfidenceCount} entries need review</span>
          ) : (
            <span className="text-green-700">no review flags</span>
          )}
        </p>
        <div className="grid grid-cols-3 gap-2 text-sm">
          {counts.map(([label, n]) => (
            <div key={label} className="rounded-md bg-neutral-50 px-3 py-2">
              <div className="text-lg font-semibold">{n}</div>
              <div className="text-xs text-neutral-500">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Cache Components opt-out (specs/008): these pages read the session (cookies)
// and must block on the server rather than prerender a static shell.
export const instant = false;
