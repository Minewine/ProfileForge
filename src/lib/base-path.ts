// Next.js prefixes <Link> and router navigation with basePath, but not raw
// fetch() calls or plain <a href>. NEXT_PUBLIC_BASE_PATH is inlined at build
// time from the same NEXT_BASE_PATH value next.config.ts uses for basePath.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Prefix an absolute app path (e.g. "/api/profile") with the basePath. */
export function apiUrl(path: string): string {
  return `${BASE_PATH}${path}`;
}
