import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { listVersions } from "@/lib/profile/repository";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(await listVersions(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
