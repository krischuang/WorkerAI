import { prisma } from "@/lib/prisma";

/** Returns the most recent Monday at midnight UTC on or before `d`. */
export function mondayOfWeek(d: Date): Date {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay(); // 0=Sun … 6=Sat
  const offset = day === 0 ? 6 : day - 1; // days since Monday
  copy.setUTCDate(copy.getUTCDate() - offset);
  return copy;
}

export async function weeklyReportExists(weekStart: Date): Promise<boolean> {
  const existing = await prisma.weeklyReport.findFirst({
    where: { weekStart },
    select: { id: true },
  });
  return existing !== null;
}

export async function generateWeeklyReport(
  weekStart: Date,
  generatedBy: "manual" | "auto" = "manual",
) {
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000 - 1);

  const [
    completedTasks,
    failedCount,
    runningCount,
    pendingCount,
    queuedCount,
    retriedCount,
    timedOutCount,
    recoveryCount,
    completedLogs,
    activeServers,
    activeAgents,
    agentList,
  ] = await Promise.all([
    prisma.task.findMany({
      where: { status: "completed", updatedAt: { gte: weekStart, lte: weekEnd } },
      select: { id: true, title: true, agentId: true, project: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    prisma.task.count({ where: { status: "failed",  updatedAt: { gte: weekStart, lte: weekEnd } } }),
    prisma.task.count({ where: { status: "running" } }),
    prisma.task.count({ where: { status: "pending" } }),
    prisma.task.count({ where: { status: "queued"  } }),
    prisma.task.count({ where: { retryCount: { gt: 0 }, updatedAt: { gte: weekStart } } }),
    prisma.executionLog.count({ where: { exitReason: "timeout", finishedAt: { gte: weekStart, lte: weekEnd } } }),
    prisma.recoveryLog.count({ where: { createdAt: { gte: weekStart, lte: weekEnd } } }),
    prisma.executionLog.findMany({
      where: { status: "completed", finishedAt: { gte: weekStart, lte: weekEnd }, durationMs: { not: null } },
      select: { durationMs: true },
    }),
    prisma.server.count({ where: { status: "connected" } }),
    prisma.agent.count({ where: { status: { in: ["idle", "running"] } } }),
    prisma.agent.findMany({ select: { id: true, name: true } }),
  ]);

  // Avg execution
  let avgExecutionMinutes: number | null = null;
  if (completedLogs.length > 0) {
    const total = completedLogs.reduce((s, l) => s + (l.durationMs ?? 0), 0);
    avgExecutionMinutes = Math.round((total / completedLogs.length / 60_000) * 10) / 10;
  }

  // Agent utilisation: completed tasks per agent this week
  const utilMap: Record<string, { name: string; count: number }> = {};
  for (const agent of agentList) {
    utilMap[agent.id] = { name: agent.name, count: 0 };
  }
  for (const task of completedTasks) {
    if (task.agentId && utilMap[task.agentId]) {
      utilMap[task.agentId].count++;
    }
  }
  const agentUtilisation = Object.values(utilMap)
    .filter((a) => a.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topCompletedTasks = completedTasks.slice(0, 10).map((t) => ({
    title:   t.title,
    project: t.project.name,
  }));

  const weekLabel    = weekStart.toISOString().slice(0, 10);
  const weekEndLabel = weekEnd.toISOString().slice(0, 10);

  const completedLines = completedTasks.length
    ? completedTasks.slice(0, 10).map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";

  const utilLines = agentUtilisation.length
    ? agentUtilisation.map((a) => `- ${a.name}: ${a.count} task${a.count !== 1 ? "s" : ""}`).join("\n")
    : "No agent data";

  const reportText = `# Weekly Report — ${weekLabel} to ${weekEndLabel}

## Summary
Completed: ${completedTasks.length} | Failed: ${failedCount} | Timeouts: ${timedOutCount} | Retried: ${retriedCount} | Recoveries: ${recoveryCount}
Avg Execution: ${avgExecutionMinutes != null ? `${avgExecutionMinutes}m` : "N/A"}
Active Servers: ${activeServers} | Active Agents: ${activeAgents}

## Top Completed Tasks
${completedLines}

## Agent Utilisation
${utilLines}

## Current State
Running: ${runningCount} | Pending: ${pendingCount} | Queued: ${queuedCount}
`;

  return prisma.weeklyReport.create({
    data: {
      weekStart,
      completedCount: completedTasks.length,
      failedCount,
      runningCount,
      pendingCount,
      queuedCount,
      retriedCount,
      timedOutCount,
      recoveryCount,
      avgExecutionMinutes,
      activeServerCount: activeServers,
      activeAgentCount:  activeAgents,
      agentUtilisation,
      topCompletedTasks,
      generatedBy,
      reportText,
    },
  });
}
