import { NextResponse, connection } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireUser } from "@/lib/auth/guard";
import { listModels } from "@/lib/settings/models";

/** Searchable OpenRouter model list for the Settings model pickers. */
export async function GET(req: Request) {
  try {
    await requireUser();
    await connection(); // request.url access must stay dynamic (cacheComponents)
    const q = new URL(req.url).searchParams.get("q") ?? "";
    const models = await listModels(q);
    return NextResponse.json({ models });
  } catch (err) {
    return errorResponse(err);
  }
}
