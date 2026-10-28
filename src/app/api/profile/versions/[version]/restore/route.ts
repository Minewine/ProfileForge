import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { restoreVersion } from "@/lib/profile/repository";

type Params = { params: Promise<{ version: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { version: raw } = await params;
    const version = Number.parseInt(raw, 10);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError("VALIDATION_ERROR", "Version must be a positive integer.");
    }
    return NextResponse.json(await restoreVersion(user.id, version));
  } catch (err) {
    return errorResponse(err);
  }
}
