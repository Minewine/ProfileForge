import { NextResponse, type NextRequest } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { CredentialsSchema, normalizeEmail } from "@/lib/auth/schemas";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";

// Verified for unknown emails so both failure paths take comparable time.
let dummyHash: string | null = null;

export async function POST(req: NextRequest) {
  try {
    const body = CredentialsSchema.parse(await req.json());
    const email = normalizeEmail(body.email);

    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true },
    });
    const ok = user
      ? await verifyPassword(user.passwordHash, body.password)
      : ((dummyHash ??= await hashPassword("timing-equalizer-dummy")), await verifyPassword(dummyHash, body.password));

    // One generic response for unknown email AND wrong password — no enumeration.
    if (!user || !ok) throw new ApiError("INVALID_CREDENTIALS", "Invalid email or password.");

    await createSession(user.id);
    return NextResponse.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    return errorResponse(err);
  }
}
