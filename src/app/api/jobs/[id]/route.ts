import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { deleteAnalysis, getAnalysis, updateLanguage } from "@/lib/jobs/repository";
import { LanguagePatchSchema } from "@/lib/jobs/schemas";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const analysis = await getAnalysis(user.id, id);
    return NextResponse.json({ analysis });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = LanguagePatchSchema.parse(await req.json());
    return NextResponse.json(await updateLanguage(user.id, id, body.language));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    await deleteAnalysis(user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
