import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { NextRequest, NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.agent.update({
      where: { id },
      data: { pausedDueToUsage: false, pausedAt: null },
    });

    await prisma.scheduledResume.updateMany({
      where: { resourceType: "agent", resourceId: id, triggered: false },
      data: { triggered: true },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError("agents/[id]/resume POST", err);
  }
}
