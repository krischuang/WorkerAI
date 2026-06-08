import { prisma } from "@/lib/prisma";

export async function GET() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    activeProjects,
    pendingTasks,
    runningTasks,
    completedToday,
    failedTasks,
    highPriorityPending,
    recentlyCompleted,
    totalServers,
    connectedServers,
    failedServers,
    lastCheckedServer,
  ] = await Promise.all([
    prisma.project.count({ where: { status: "active" } }),
    prisma.task.count({ where: { status: "pending" } }),
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
  ]);

  return Response.json({
    activeProjects,
    pendingTasks,
    runningTasks,
    completedToday,
    failedTasks,
    highPriorityPending,
    recentlyCompleted,
    servers: { totalServers, connectedServers, failedServers, lastCheckedServer },
  });
}
