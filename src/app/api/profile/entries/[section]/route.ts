import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { createEntry } from "@/lib/profile/repository";
import { CreateSchemas, parseSection } from "@/lib/profile/sectionSchemas";

type Params = { params: Promise<{ section: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { section: raw } = await params;
    const section = parseSection(raw);
    const data = CreateSchemas[section].parse(await req.json());
    const result = await createEntry(user.id, section, data as unknown as Record<string, unknown>);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
