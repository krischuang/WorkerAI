import { prisma } from "@/lib/prisma";

/** Returns midnight UTC on the 1st of the month containing `d`. */
export function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function monthlyReportExists(monthStart: Date): Promise<boolean> {
  const existing = await prisma.monthlyReport.findFirst({
    where: { monthStart },
    select: { id: true },
  });
  return existing !== null;
}

export async function generateMonthlyReport(
  monthStart: Date,
  generatedBy: "manual" | "auto" = "manual",
) {
  // End of month: start of next month minus 1 ms
  const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const monthEnd  = new Date(nextMonth.getTime() - 1);

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
      where: { status: "completed", updatedAt: { gte: monthStart, lte: monthEnd } },
      select: { id: true, title: true, agentId: true, project: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
    prisma.task.count({ where: { status: "failed",  updatedAt: { gte: monthStart, lte: monthEnd } } }),
    prisma.task.count({ where: { status: "running" } }),
    prisma.task.count({ where: { status: "pending" } }),
    prisma.task.count({ where: { status: "queued"  } }),
    prisma.task.count({ where: { retryCount: { gt: 0 }, updatedAt: { gte: monthStart } } }),
    prisma.executionLog.count({ where: { exitReason: "timeout", finishedAt: { gte: monthStart, lte: monthEnd } } }),
    prisma.recoveryLog.count({ where: { createdAt: { gte: monthStart, lte: monthEnd } } }),
    prisma.executionLog.findMany({
      where: { status: "completed", finishedAt: { gte: monthStart, lte: monthEnd }, durationMs: { not: null } },
      select: { durationMs: true },
    }),
    prisma.server.count({ where: { status: "connected" } }),
    prisma.agent.count({ where: { status: { in: ["idle", "running"] } } }),
    prisma.agent.findMany({ select: { id: true, name: true } }),
  ]);

  let avgExecutionMinutes: number | null = null;
  if (completedLogs.length > 0) {
    const total = completedLogs.reduce((s, l) => s + (l.durationMs ?? 0), 0);
    avgExecutionMinutes = Math.round((total / completedLogs.length / 60_000) * 10) / 10;
  }

  // Agent utilisation: completed tasks per agent this month
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

  const topCompletedTasks = completedTasks.slice(0, 15).map((t) => ({
    title:   t.title,
    project: t.project.name,
  }));

  const monthLabel = monthStart.toISOString().slice(0, 7); // "2026-06"

  const completedLines = completedTasks.length
    ? completedTasks.slice(0, 15).map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";

  const utilLines = agentUtilisation.length
    ? agentUtilisation.map((a) => `- ${a.name}: ${a.count} task${a.count !== 1 ? "s" : ""}`).join("\n")
    : "No agent data";

  const reportText = `# Monthly Report — ${monthLabel}

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

  return prisma.monthlyReport.create({
    data: {
      monthStart,
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
