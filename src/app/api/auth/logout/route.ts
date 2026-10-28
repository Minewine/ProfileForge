import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { destroySession } from "@/lib/auth/session";

export async function POST() {
  try {
    await destroySession();
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
