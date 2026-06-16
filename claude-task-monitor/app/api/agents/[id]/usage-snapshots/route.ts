import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { jsonResponse } from "@/lib/json-response";

type Ctx = { params: Promise<{ id: string }> };

/** Latest usage snapshots for an agent — backs the expandable raw-capture viewer on the agent detail page. */
export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const limitParam = request.nextUrl.searchParams.get("limit");
    const limit = Math.min(Math.max(parseInt(limitParam ?? "5", 10) || 5, 1), 20);

    const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const snapshots = await prisma.agentUsageSnapshot.findMany({
      where: { agentId: id },
      orderBy: { capturedAt: "desc" },
      take: limit,
    });

    return jsonResponse(snapshots);
  } catch (err) {
    return serverError("agents/[id]/usage-snapshots GET", err);
  }
}
