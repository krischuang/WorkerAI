import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-error";
import { approveCycle } from "@/lib/improvement-cycle-service";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/improvement-cycles/[id]/approve — approve awaiting_approval cycle */
export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await approveCycle(id);
    if (!result.ok) {
      const status = result.error === "Not found" ? 404 : 409;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError("improvement-cycles/[id]/approve POST", err);
  }
}
