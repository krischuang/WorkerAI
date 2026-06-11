import { prisma } from "@/lib/prisma";

export interface CapacityBreakdown {
  capacityScore: number;
  usageHeadroom: number;
  taskSlotRoom: number;
  healthContrib: number;
  activeTaskCount: number;
  maxConcurrentTasks: number;
  sessionPct: number | null;
  weekPct: number | null;
  healthScore: number | null;
}

export function computeCapacityScore(
  sessionPct: number | null,
  weekPct: number | null,
  activeTaskCount: number,
  maxConcurrentTasks: number,
  healthScore: number | null,
): CapacityBreakdown {
  const usagePct = Math.max(sessionPct ?? 0, weekPct ?? 0);
  const usageHeadroom = (100 - usagePct) * 0.5;
  const taskSlotRoom = (1 - activeTaskCount / Math.max(maxConcurrentTasks, 1)) * 30;
  const healthContrib = (healthScore ?? 50) * 0.2;
  const capacityScore = Math.max(0, Math.min(100, usageHeadroom + taskSlotRoom + healthContrib));

  return {
    capacityScore,
    usageHeadroom,
    taskSlotRoom,
    healthContrib,
    activeTaskCount,
    maxConcurrentTasks,
    sessionPct,
    weekPct,
    healthScore,
  };
}

export async function updateAllServerCapacity(): Promise<void> {
  const servers = await prisma.server.findMany({
    select: {
      id: true,
      claudeSessionPct: true,
      claudeWeekPct: true,
      healthScore: true,
      maxConcurrentTasks: true,
      _count: { select: { tasks: { where: { status: { in: ["running", "queued"] } } } } },
    },
  });

  await Promise.allSettled(
    servers.map(async (srv) => {
      const activeTaskCount = srv._count.tasks;
      const breakdown = computeCapacityScore(
        srv.claudeSessionPct,
        srv.claudeWeekPct,
        activeTaskCount,
        srv.maxConcurrentTasks,
        srv.healthScore,
      );
      await prisma.server.update({
        where: { id: srv.id },
        data: {
          capacityScore: breakdown.capacityScore,
          activeTaskCount,
          capacityUpdatedAt: new Date(),
        },
      });
    })
  );
}
