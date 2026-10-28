import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { validateProfileClaims } from "@/lib/validation/claims";

export async function POST(_req: NextRequest) {
  try {
    const user = await requireUser();
    return NextResponse.json(await validateProfileClaims(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
