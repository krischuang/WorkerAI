import { serverError } from "@/lib/api-error";
import { getCycleHealth, recoverStuckCycle } from "@/lib/improvement-recovery";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const health = await getCycleHealth(id);
    if (!health) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(health);
  } catch (err) {
    return serverError("projects/[id]/improvement/recover GET", err);
  }
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const health = await getCycleHealth(id);
    if (!health) return Response.json({ error: "Not found" }, { status: 404 });

    if (!health.isStuck) {
      return Response.json({ ok: false, message: "No stuck scans or cycles found" });
    }

    const summary = await recoverStuckCycle(id);
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    return serverError("projects/[id]/improvement/recover POST", err);
  }
}
