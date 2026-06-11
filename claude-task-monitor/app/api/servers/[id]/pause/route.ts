import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { upsertScheduledResume, nearestResetsAt } from "@/lib/scheduled-resume";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const server = await prisma.server.findUnique({
      where: { id },
      select: { id: true, claudeSessionResetsAt: true, claudeWeekResetsAt: true },
    });
    if (!server) return Response.json({ error: "Not found" }, { status: 404 });

    await prisma.server.update({
      where: { id },
      data: { pausedDueToUsage: true, pausedAt: new Date() },
    });

    const resumeAt = nearestResetsAt(server.claudeSessionResetsAt, server.claudeWeekResetsAt);
    if (resumeAt) {
      await upsertScheduledResume("server", id, resumeAt);
    }

    return Response.json({ ok: true, resumeAt: resumeAt?.toISOString() ?? null });
  } catch (err) {
    return serverError("servers/[id]/pause POST", err);
  }
}
