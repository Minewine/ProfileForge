import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { proxy } from "@/proxy";

// Subdirectory deployment guard (DEPLOY.md: the app is mounted at
// /profile-forge). Next prefixes <Link>/router navigation with basePath but
// NOT raw fetch() calls, plain <a href>, or hand-built redirect URLs — each of
// those 404s behind the mount unless it goes through apiUrl / nextUrl.

const BASE = "/profile-forge";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** BASE_PATH is read once at module load (it is inlined at build time), so
 *  each case re-imports the module under its own env. */
async function loadApiUrl(basePath: string | undefined) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
  return (await import("@/lib/base-path")).apiUrl;
}

describe("apiUrl", () => {
  it("prefixes the basePath when one is configured", async () => {
    const apiUrl = await loadApiUrl(BASE);
    expect(apiUrl("/api/auth/register")).toBe("/profile-forge/api/auth/register");
  });

  it("keeps query strings and dynamic segments intact", async () => {
    const apiUrl = await loadApiUrl(BASE);
    expect(apiUrl("/api/generations/abc/download?format=pdf")).toBe(
      "/profile-forge/api/generations/abc/download?format=pdf",
    );
  });

  it("returns the path unchanged at the root (env set to empty by next.config)", async () => {
    const apiUrl = await loadApiUrl("");
    expect(apiUrl("/api/profile")).toBe("/api/profile");
  });

  it("returns the path unchanged when the env var is absent (tests, tooling)", async () => {
    const apiUrl = await loadApiUrl(undefined);
    expect(apiUrl("/api/profile")).toBe("/api/profile");
  });
});

describe("proxy unauthenticated redirect", () => {
  function request(pathname: string, opts: { basePath?: string; cookie?: boolean } = {}) {
    // the mounted root arrives as "/profile-forge" (Next 308s the trailing slash away)
    const url = `https://example.com${opts.basePath ?? ""}${opts.basePath && pathname === "/" ? "" : pathname}`;
    const req = new NextRequest(url, {
      ...(opts.basePath ? { nextConfig: { basePath: opts.basePath } } : {}),
    });
    if (opts.cookie) req.cookies.set(SESSION_COOKIE, "some-token");
    return req;
  }

  it("keeps the basePath on the /login redirect", () => {
    const res = proxy(request("/profile", { basePath: BASE }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.com/profile-forge/login");
  });

  it("redirects the mounted root too", () => {
    const res = proxy(request("/", { basePath: BASE }));
    expect(res.headers.get("location")).toBe("https://example.com/profile-forge/login");
  });

  it("redirects to /login at the root when no basePath is set", () => {
    const res = proxy(request("/jobs/123"));
    expect(res.headers.get("location")).toBe("https://example.com/login");
  });

  it("lets a request with a session cookie through", () => {
    const res = proxy(request("/profile", { basePath: BASE, cookie: true }));
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not gate public pages", () => {
    const res = proxy(request("/login", { basePath: BASE }));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("client code never bypasses the basePath", () => {
  const SRC = path.resolve(__dirname, "../../src");

  function clientSources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // route handlers and the generated Prisma client are server-only
        if (full === path.join(SRC, "app", "api") || entry.name === "generated") return [];
        return clientSources(full);
      }
      return entry.name.endsWith(".tsx") ? [full] : [];
    });
  }

  // fetch("/…"), fetch(`/…`), fetch(cond ? "/…" and href="/api…" / href={`/api…`}
  // — anything already wrapped as fetch(apiUrl(…)) is fine
  const RAW_FETCH = /fetch\(\s*(?!apiUrl\()(?:[^,)]*\?\s*)?["'`]\//;
  const RAW_API_HREF = /href=\{?["'`]\/api\//;

  it("finds the client sources it is meant to scan", () => {
    expect(clientSources(SRC).length).toBeGreaterThan(5);
  });

  it("has no raw absolute fetch() path or raw /api href", () => {
    const offenders = clientSources(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, where: `${path.relative(SRC, file)}:${i + 1}` }))
        .filter(({ line }) => RAW_FETCH.test(line) || RAW_API_HREF.test(line))
        .map(({ where }) => where),
    );
    expect(offenders).toEqual([]);
  });
});
