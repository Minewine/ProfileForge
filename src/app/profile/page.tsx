import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/guard";
import { ProfileEditorView } from "./profile-view";

export default async function ProfilePage() {
  if (!(await getCurrentUser())) redirect("/login");
  return <ProfileEditorView />;
}

// Cache Components opt-out (specs/008): these pages read the session (cookies)
// and must block on the server rather than prerender a static shell.
export const instant = false;
