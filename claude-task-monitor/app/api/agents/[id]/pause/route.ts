import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { upsertScheduledResume, nearestResetsAt } from "@/lib/scheduled-resume";
import { NextRequest, NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const agent = await prisma.agent.findUnique({
      where: { id },
      select: { id: true, claudeSessionResetsAt: true, claudeWeekResetsAt: true },
    });
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.agent.update({
      where: { id },
      data: { pausedDueToUsage: true, pausedAt: new Date() },
    });

    const resumeAt = nearestResetsAt(agent.claudeSessionResetsAt, agent.claudeWeekResetsAt);
    if (resumeAt) {
      await upsertScheduledResume("agent", id, resumeAt);
    }

    return NextResponse.json({ ok: true, resumeAt: resumeAt?.toISOString() ?? null });
  } catch (err) {
    return serverError("agents/[id]/pause POST", err);
  }
}
