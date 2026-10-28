import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Optimistic unauthenticated gate ONLY (specs/008, research R8): Next 16 renamed
 * middleware to proxy, and the bundled docs are explicit that proxy is not an
 * authorization boundary — it cannot validate the session against the database.
 * Real enforcement lives in the pages (getCurrentUser → redirect) and in every
 * API route (requireUser → 401). This only avoids flashing the app shell to a
 * visitor with no session cookie at all.
 */
const PROTECTED_PAGE = /^\/(profile|upload|jobs|settings)(\/|$)/;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (!hasSessionCookie && (pathname === "/" || PROTECTED_PAGE.test(pathname))) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/profile/:path*", "/upload/:path*", "/jobs/:path*", "/settings/:path*"],
};
