import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { CredentialsSchema, normalizeEmail } from "@/lib/auth/schemas";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  try {
    const body = CredentialsSchema.parse(await req.json());
    const email = normalizeEmail(body.email);
    const passwordHash = await hashPassword(body.password);

    let user: { id: string; email: string };
    try {
      user = await db.user.create({ data: { email, passwordHash }, select: { id: true, email: true } });
    } catch (err) {
      // race-safe duplicate detection via the DB unique index (contracts/auth-api.md)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ApiError("EMAIL_TAKEN", "An account with this email already exists.");
      }
      throw err;
    }

    await createSession(user.id);
    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
