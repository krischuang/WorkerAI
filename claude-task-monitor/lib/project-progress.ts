import { prisma } from "./prisma";

const TAG = "[project-progress]";

/**
 * Recompute and persist progress fields for a single project.
 *
 * completionPct = (completed + archived) / total * 100
 *
 * estimatedCompletionAt is derived from the velocity of tasks completed in
 * the last 7 days: tasksPerDay = completedLast7d / 7, then remaining / rate.
 */
export async function recalculateProjectProgress(projectId: string): Promise<void> {
  try {
    const counts = await prisma.task.groupBy({
      by: ["status"],
      where: { projectId },
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    for (const row of counts) {
      byStatus[row.status] = row._count._all;
    }

    const totalTasks = Object.values(byStatus).reduce((s, n) => s + n, 0);
    const completedTasks = (byStatus["completed"] ?? 0) + (byStatus["archived"] ?? 0);
    const failedTasks = byStatus["failed"] ?? 0;
    const runningTasks = byStatus["running"] ?? 0;
    const pendingTasks = (byStatus["pending"] ?? 0) + (byStatus["queued"] ?? 0) + (byStatus["paused"] ?? 0);

    const completionPct = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

    // Velocity: tasks completed in the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentlyCompleted = await prisma.task.count({
      where: {
        projectId,
        status: { in: ["completed", "archived"] },
        updatedAt: { gte: sevenDaysAgo },
      },
    });

    let estimatedCompletionAt: Date | null = null;
    const remaining = totalTasks - completedTasks - failedTasks;
    if (remaining > 0 && recentlyCompleted > 0) {
      const tasksPerMs = recentlyCompleted / (7 * 24 * 60 * 60 * 1000);
      const msRemaining = remaining / tasksPerMs;
      estimatedCompletionAt = new Date(Date.now() + msRemaining);
    }

    await prisma.project.update({
      where: { id: projectId },
      data: {
        completionPct,
        totalTasks,
        completedTasks,
        failedTasks,
        runningTasks,
        pendingTasks,
        progressUpdatedAt: new Date(),
        estimatedCompletionAt,
      },
    });
  } catch (err) {
    console.error(`${TAG} recalculate(${projectId}) failed:`, err);
  }
}

/**
 * Full reconciliation pass — recalculates all projects.
 * Called every 10 poller cycles to fix any drift.
 */
export async function reconcileAllProjects(): Promise<void> {
  try {
    const projects = await prisma.project.findMany({ select: { id: true } });
    await Promise.allSettled(projects.map((p) => recalculateProjectProgress(p.id)));
    console.log(`${TAG} reconciled ${projects.length} projects`);
  } catch (err) {
    console.error(`${TAG} reconcileAllProjects failed:`, err);
  }
}

/**
 * Returns tasks-per-day velocity and a breakdown for the last 7 days.
 */
export async function getProjectVelocity(projectId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const completedLast7d = await prisma.task.count({
    where: {
      projectId,
      status: { in: ["completed", "archived"] },
      updatedAt: { gte: sevenDaysAgo },
    },
  });

  const tasksPerDay = completedLast7d / 7;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      completionPct: true,
      totalTasks: true,
      completedTasks: true,
      pendingTasks: true,
      estimatedCompletionAt: true,
    },
  });

  return {
    completedLast7d,
    tasksPerDay: Math.round(tasksPerDay * 100) / 100,
    completionPct: project?.completionPct ?? null,
    totalTasks: project?.totalTasks ?? null,
    completedTasks: project?.completedTasks ?? null,
    pendingTasks: project?.pendingTasks ?? null,
    estimatedCompletionAt: project?.estimatedCompletionAt ?? null,
  };
}
