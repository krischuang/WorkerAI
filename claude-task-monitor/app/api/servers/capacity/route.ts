import { prisma } from "@/lib/prisma";
import { computeCapacityScore } from "@/lib/server-capacity";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const servers = await prisma.server.findMany({
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
      orderBy: { name: "asc" },
    });

    return Response.json(
      servers.map((srv) => {
        const liveActiveCount = srv._count.tasks;
        const breakdown = computeCapacityScore(
          srv.claudeSessionPct,
          srv.claudeWeekPct,
          liveActiveCount,
          srv.maxConcurrentTasks,
          srv.healthScore,
        );
        return {
          id: srv.id,
          name: srv.name,
          host: srv.host,
          status: srv.status,
          capacityScore: breakdown.capacityScore,
          activeTaskCount: liveActiveCount,
          maxConcurrentTasks: srv.maxConcurrentTasks,
          capacityUpdatedAt: srv.capacityUpdatedAt,
        };
      })
    );
  } catch (err) {
    return serverError("servers/capacity GET", err);
  }
}
