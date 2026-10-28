import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/guard";
import { AnalysisView } from "./job-detail-view";

export default async function AnalysisPage() {
  if (!(await getCurrentUser())) redirect("/login");
  return <AnalysisView />;
}

// Cache Components opt-out (specs/008): these pages read the session (cookies)
// and must block on the server rather than prerender a static shell.
export const instant = false;
