"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Invalid email or password.",
  EMAIL_TAKEN: "An account with this email already exists.",
};

/**
 * Shared email+password form for /login and /register (specs/008, US1).
 * Posts JSON to the auth API and follows the standard error envelope.
 */
export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isLogin = mode === "login";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(isLogin ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.push("/profile");
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => null);
      const code = body?.error?.code as string | undefined;
      setError(
        (code && ERROR_MESSAGES[code]) ||
          (code === "VALIDATION_ERROR"
            ? "Please enter a valid email and a password of at least 8 characters."
            : "Something went wrong. Please try again."),
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm space-y-4 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{isLogin ? "Sign in" : "Create an account"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete={isLogin ? "current-password" : "new-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Working…" : isLogin ? "Sign in" : "Create account"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-neutral-600">
            {isLogin ? (
              <>
                No account yet?{" "}
                <Link href="/register" className="underline underline-offset-4 hover:text-neutral-900">
                  Register
                </Link>
              </>
            ) : (
              <>
                Already registered?{" "}
                <Link href="/login" className="underline underline-offset-4 hover:text-neutral-900">
                  Sign in
                </Link>
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
