import { prisma } from "@/lib/prisma";
import { computeCapacityScore } from "@/lib/server-capacity";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const srv = await prisma.server.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        host: true,
        status: true,
        claudeSessionPct: true,
        claudeWeekPct: true,
        healthScore: true,
        maxConcurrentTasks: true,
        capacityScore: true,
        activeTaskCount: true,
        capacityUpdatedAt: true,
        _count: { select: { tasks: { where: { status: { in: ["running", "queued"] } } } } },
      },
    });

    if (!srv) return Response.json({ error: "Not found" }, { status: 404 });

    const liveActiveCount = srv._count.tasks;
    const breakdown = computeCapacityScore(
      srv.claudeSessionPct,
      srv.claudeWeekPct,
      liveActiveCount,
      srv.maxConcurrentTasks,
      srv.healthScore,
    );

    return Response.json({
      id: srv.id,
      name: srv.name,
      host: srv.host,
      status: srv.status,
      capacityScore: breakdown.capacityScore,
      activeTaskCount: liveActiveCount,
      maxConcurrentTasks: srv.maxConcurrentTasks,
      capacityUpdatedAt: srv.capacityUpdatedAt,
      breakdown: {
        usageHeadroom: breakdown.usageHeadroom,
        taskSlotRoom: breakdown.taskSlotRoom,
        healthContrib: breakdown.healthContrib,
        sessionPct: breakdown.sessionPct,
        weekPct: breakdown.weekPct,
        healthScore: breakdown.healthScore,
      },
    });
  } catch (err) {
    return serverError("servers/[id]/capacity GET", err);
  }
}
