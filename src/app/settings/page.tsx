import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/guard";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  if (!(await getCurrentUser())) redirect("/login");
  return <SettingsView />;
}

// Cache Components opt-out (specs/008): these pages read the session (cookies)
// and must block on the server rather than prerender a static shell.
export const instant = false;
