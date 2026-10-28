import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { deleteEntry, updateEntry } from "@/lib/profile/repository";
import { PatchSchemas, parseSection } from "@/lib/profile/sectionSchemas";

type Params = { params: Promise<{ section: string; id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { section: raw, id } = await params;
    const section = parseSection(raw);
    const patch = PatchSchemas[section].parse(await req.json());
    const result = await updateEntry(user.id, section, id, patch as unknown as Record<string, unknown>);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { section: raw, id } = await params;
    const section = parseSection(raw);
    const result = await deleteEntry(user.id, section, id);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
