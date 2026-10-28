import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/guard";
import { AuthForm } from "@/components/auth-form";

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/profile");
  return <AuthForm mode="register" />;
}

// Cache Components opt-out (specs/008): these pages read the session (cookies)
// and must block on the server rather than prerender a static shell.
export const instant = false;
