import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ user });
  } catch (err) {
    return errorResponse(err);
  }
}
