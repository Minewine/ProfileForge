import { ApiError } from "@/lib/api/errors";
import { getSessionUser } from "./session";

export type SessionUser = { id: string; email: string };

/** Server components: the signed-in user, or null (pages redirect to /login). */
export async function getCurrentUser(): Promise<SessionUser | null> {
  return getSessionUser();
}

/** Route handlers: the signed-in user, or throws 401 UNAUTHENTICATED — every
 * route's existing `catch (err) errorResponse(err)` turns that into the
 * standard error envelope. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required.");
  return user;
}
