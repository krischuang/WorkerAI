import { prisma } from "@/lib/prisma";

export async function generateDailyReport(generatedBy: "manual" | "auto" = "manual") {
  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const periodEnd = new Date(periodStart.getTime() + 86_400_000 - 1);

  const [
    completedToday,
    failedToday,
    running,
    pending,
    queued,
    retriedTasks,
    timedOutLogs,
    recoveryLogs,
    completedLogs,
    allProjects,
    activeServers,
    activeAgents,
  ] = await Promise.all([
    prisma.task.findMany({
      where: { status: "completed", updatedAt: { gte: periodStart, lte: periodEnd } },
      include: { project: { select: { name: true } } },
    }),
    prisma.task.findMany({
      where: { status: "failed", updatedAt: { gte: periodStart, lte: periodEnd } },
      include: { project: { select: { name: true } } },
    }),
    prisma.task.findMany({
      where: { status: "running" },
      include: { project: { select: { name: true } } },
    }),
    prisma.task.findMany({
      where: { status: "pending" },
      include: {
        project: { select: { name: true, priority: true, status: true } },
      },
      orderBy: [{ priority: "asc" }],
      take: 5,
    }),
    prisma.task.count({ where: { status: "queued" } }),
    prisma.task.count({
      where: { retryCount: { gt: 0 }, updatedAt: { gte: periodStart } },
    }),
    prisma.executionLog.count({
      where: { exitReason: "timeout", finishedAt: { gte: periodStart, lte: periodEnd } },
    }),
    prisma.recoveryLog.count({
      where: { createdAt: { gte: periodStart, lte: periodEnd } },
    }),
    prisma.executionLog.findMany({
      where: {
        status: "completed",
        finishedAt: { gte: periodStart, lte: periodEnd },
        durationMs: { not: null },
      },
      select: { durationMs: true },
    }),
    prisma.project.findMany({
      where: { status: "active" },
      include: {
        tasks: { where: { status: "pending" }, select: { priority: true } },
      },
      orderBy: { priority: "asc" },
    }),
    prisma.server.count({ where: { status: "connected" } }),
    prisma.agent.count({ where: { status: { in: ["idle", "running"] } } }),
  ]);

  const topProject = allProjects[0] ?? null;

  let avgExecutionMinutes: number | null = null;
  if (completedLogs.length > 0) {
    const totalMs = completedLogs.reduce((sum, l) => sum + (l.durationMs ?? 0), 0);
    avgExecutionMinutes = Math.round((totalMs / completedLogs.length / 60_000) * 10) / 10;
  }

  const completedLines = completedToday.length
    ? completedToday.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";

  const failedLines = failedToday.length
    ? failedToday.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";

  const runningLines = running.length
    ? running.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";

  const nextLines = pending.length
    ? pending
        .map((t) => `- [${t.priority}] [${t.project.name}] ${t.title}`)
        .join("\n")
    : "None";

  const reportText = `# Daily Report — ${now.toUTCString().slice(0, 16)}

## Completed Today
${completedLines}

## Currently Running
${runningLines}

## Failed Today
${failedLines}

## Recommended Next Tasks
${nextLines}

## Highest Priority Project Tomorrow
${topProject ? `${topProject.name} (${topProject.priority})` : "N/A"}

## Infrastructure
Active Servers: ${activeServers} | Active Agents: ${activeAgents}
Avg Execution: ${avgExecutionMinutes != null ? `${avgExecutionMinutes}m` : "N/A"} | Timeouts: ${timedOutLogs} | Retried: ${retriedTasks} | Recoveries: ${recoveryLogs}
`;

  const report = await prisma.dailyReport.create({
    data: {
      date: now,
      periodStart,
      periodEnd,
      completedCount: completedToday.length,
      failedCount: failedToday.length,
      runningCount: running.length,
      pendingCount: pending.length,
      queuedCount: queued,
      retriedCount: retriedTasks,
      timedOutCount: timedOutLogs,
      recoveryCount: recoveryLogs,
      avgExecutionMinutes,
      activeServerCount: activeServers,
      activeAgentCount: activeAgents,
      generatedBy,
      reportText,
      topProjectId: topProject?.id ?? null,
      topProjectName: topProject?.name ?? null,
    },
  });

  return report;
}

export async function todaysReportExists(): Promise<boolean> {
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const existing = await prisma.dailyReport.findFirst({
    where: { date: { gte: dayStart, lt: dayEnd } },
    select: { id: true },
  });
  return existing !== null;
}
