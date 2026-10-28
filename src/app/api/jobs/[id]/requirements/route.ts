import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { replaceRequirements } from "@/lib/jobs/repository";
import { RequirementsPutSchema } from "@/lib/jobs/schemas";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = RequirementsPutSchema.parse(await req.json());
    const result = await replaceRequirements(user.id, id, body.requirements, body.finalize);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
