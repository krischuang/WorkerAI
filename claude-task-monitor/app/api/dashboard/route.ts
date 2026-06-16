import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const thresholdRow = await prisma.systemConfig.findUnique({
    where: { key: "stale_pending_alert_minutes" },
    select: { value: true },
  });
  const thresholdMinutes = Math.max(1, parseInt(thresholdRow?.value ?? "60", 10) || 60);
  const stalePendingCutoff = new Date(now.getTime() - thresholdMinutes * 60_000);

  const [
    activeProjects,
    pendingTasks,
    stalePendingCount,
    queuedTasks,
    runningTasks,
    completedToday,
    failedTasks,
    highPriorityPending,
    recentlyCompleted,
    totalServers,
    connectedServers,
    failedServers,
    lastCheckedServer,
    serversWithUsage,
    agentsWithUsage,
    upcomingScheduled,
  ] = await Promise.all([
    prisma.project.count({ where: { status: "active" } }),
    prisma.task.count({ where: { status: "pending" } }),
    prisma.task.count({ where: { status: "pending", createdAt: { lte: stalePendingCutoff } } }),
    prisma.task.count({ where: { status: "queued" } }),
    prisma.task.count({ where: { status: "running" } }),
    prisma.task.count({
      where: { status: "completed", updatedAt: { gte: startOfDay } },
    }),
    prisma.task.count({ where: { status: "failed" } }),
    prisma.task.findMany({
      where: { status: "pending", priority: { in: ["P1", "P2"] } },
      include: { project: { select: { name: true, priority: true } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: 5,
    }),
    prisma.task.findMany({
      where: { status: "completed", updatedAt: { gte: startOfDay } },
      include: { project: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
    prisma.server.count(),
    prisma.server.count({ where: { status: "connected" } }),
    prisma.server.count({ where: { status: "failed" } }),
    prisma.server.findFirst({
      where: { lastCheckedAt: { not: null } },
      orderBy: { lastCheckedAt: "desc" },
      select: { id: true, name: true, status: true, lastCheckedAt: true },
    }),
    prisma.server.findMany({
      where: { claudeSessionResetsAt: { not: null } },
      select: {
        id: true,
        name: true,
        claudeSessionPct: true,
        claudeWeekPct: true,
        claudeSessionResetsAt: true,
        claudeWeekResetsAt: true,
        pausedDueToUsage: true,
      },
    }),
    prisma.agent.findMany({
      where: { claudeSessionResetsAt: { not: null } },
      select: {
        id: true,
        name: true,
        claudeSessionPct: true,
        claudeWeekPct: true,
        claudeSessionResetsAt: true,
        claudeWeekResetsAt: true,
        pausedDueToUsage: true,
      },
    }),
    prisma.scheduledTask.findMany({
      where: { enabled: true, nextRunAt: { not: null } },
      select: {
        id: true,
        title: true,
        cronSchedule: true,
        nextRunAt: true,
        lastRunAt: true,
        priority: true,
        project: { select: { name: true } },
        spawnedTasks: {
          select: { id: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { nextRunAt: "asc" },
      take: 5,
    }),
  ]);

  // Build quota-reset entries: one entry per resource, keyed by the nearest of
  // session and week reset times. Only include resources that have at least one
  // reset timestamp so operators can see when quota will free up.
  type QuotaEntry = {
    resourceType: "server" | "agent";
    resourceId: string;
    name: string;
    sessionPct: number | null;
    weekPct: number | null;
    sessionResetsAt: string | null;
    weekResetsAt: string | null;
    nearestResetsAt: string;
    pausedDueToUsage: boolean;
  };

  const quotaEntries: QuotaEntry[] = [];

  for (const srv of serversWithUsage) {
    const nearest = nearestDate(srv.claudeSessionResetsAt, srv.claudeWeekResetsAt);
    if (!nearest) continue;
    quotaEntries.push({
      resourceType: "server",
      resourceId: srv.id,
      name: srv.name,
      sessionPct: srv.claudeSessionPct,
      weekPct: srv.claudeWeekPct,
      sessionResetsAt: srv.claudeSessionResetsAt?.toISOString() ?? null,
      weekResetsAt: srv.claudeWeekResetsAt?.toISOString() ?? null,
      nearestResetsAt: nearest.toISOString(),
      pausedDueToUsage: srv.pausedDueToUsage,
    });
  }

  for (const agent of agentsWithUsage) {
    const nearest = nearestDate(agent.claudeSessionResetsAt, agent.claudeWeekResetsAt);
    if (!nearest) continue;
    quotaEntries.push({
      resourceType: "agent",
      resourceId: agent.id,
      name: agent.name,
      sessionPct: agent.claudeSessionPct,
      weekPct: agent.claudeWeekPct,
      sessionResetsAt: agent.claudeSessionResetsAt?.toISOString() ?? null,
      weekResetsAt: agent.claudeWeekResetsAt?.toISOString() ?? null,
      nearestResetsAt: nearest.toISOString(),
      pausedDueToUsage: agent.pausedDueToUsage,
    });
  }

  // Sort by nearest reset time ascending so the most urgent appear first.
  quotaEntries.sort(
    (a, b) => new Date(a.nearestResetsAt).getTime() - new Date(b.nearestResetsAt).getTime()
  );

  return Response.json({
      activeProjects,
      pendingTasks,
      stalePendingCount,
      queuedTasks,
      runningTasks,
      completedToday,
      failedTasks,
      highPriorityPending,
      recentlyCompleted,
      servers: { totalServers, connectedServers, failedServers, lastCheckedServer },
      quotaResets: quotaEntries,
      upcomingScheduled: upcomingScheduled.map((s) => ({
        id: s.id,
        title: s.title,
        cronSchedule: s.cronSchedule,
        nextRunAt: s.nextRunAt?.toISOString() ?? null,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
        priority: s.priority,
        project: s.project,
        lastRunStatus: s.spawnedTasks[0]?.status ?? null,
        lastRunTaskId: s.spawnedTasks[0]?.id ?? null,
      })),
    });
  } catch (err) {
    console.error("[dashboard] query failed:", err);
    return Response.json({ error: "Failed to load dashboard" }, { status: 500 });
  }
}

function nearestDate(a: Date | null, b: Date | null): Date | null {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}
