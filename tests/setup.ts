/**
 * Global vitest mock for `next/headers` (specs/008): route handlers and guards
 * read the session cookie through `cookies()`, which only exists inside a real
 * Next.js request scope. Every test file gets a controllable in-memory store;
 * tests (or tests/support/auth.ts) set `cookieMock.token` to a raw session
 * token to act as a signed-in browser.
 */
import { vi } from "vitest";

const handle = vi.hoisted(() => ({
  store: {
    token: undefined as string | undefined,
    sets: [] as Array<{ name: string; value: string; options?: Record<string, unknown> }>,
    deletes: [] as string[],
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "pf_session" && handle.store.token !== undefined
        ? { name, value: handle.store.token }
        : undefined,
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (name === "pf_session") handle.store.token = value;
      handle.store.sets.push({ name, value, options });
    },
    delete: (name: string) => {
      if (name === "pf_session") handle.store.token = undefined;
      handle.store.deletes.push(name);
    },
  })),
  headers: vi.fn(async () => ({
    get: (name: string) => (name === "x-forwarded-proto" ? "http" : null),
  })),
}));

export const cookieMock = handle.store;
