import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get("days") ?? "30", 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const logs = await prisma.executionLog.findMany({
    where: {
      status: "completed",
      finishedAt: { gte: since },
      actualCostUsd: { not: null },
    },
    select: {
      id: true,
      actualCostUsd: true,
      tokenCount: true,
      finishedAt: true,
      task: {
        select: {
          id: true,
          title: true,
          projectId: true,
          agentId: true,
          project: { select: { id: true, name: true } },
          agent: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { finishedAt: "desc" },
  });

  const total = logs.reduce((sum, l) => sum + (l.actualCostUsd ?? 0), 0);
  const totalTokens = logs.reduce((sum, l) => sum + (l.tokenCount ?? 0), 0);

  // Aggregate by project
  const projectMap = new Map<string, { id: string; name: string; cost: number; tokens: number; count: number }>();
  for (const l of logs) {
    const p = l.task.project;
    if (!p) continue;
    const entry = projectMap.get(p.id) ?? { id: p.id, name: p.name, cost: 0, tokens: 0, count: 0 };
    entry.cost += l.actualCostUsd ?? 0;
    entry.tokens += l.tokenCount ?? 0;
    entry.count += 1;
    projectMap.set(p.id, entry);
  }

  // Aggregate by agent
  const agentMap = new Map<string, { id: string; name: string; cost: number; tokens: number; count: number }>();
  for (const l of logs) {
    const a = l.task.agent;
    if (!a) continue;
    const entry = agentMap.get(a.id) ?? { id: a.id, name: a.name, cost: 0, tokens: 0, count: 0 };
    entry.cost += l.actualCostUsd ?? 0;
    entry.tokens += l.tokenCount ?? 0;
    entry.count += 1;
    agentMap.set(a.id, entry);
  }

  // Daily cost trend
  const dailyMap = new Map<string, number>();
  for (const l of logs) {
    if (!l.finishedAt) continue;
    const day = l.finishedAt.toISOString().slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + (l.actualCostUsd ?? 0));
  }

  return NextResponse.json({
    period: { days, since: since.toISOString() },
    total,
    totalTokens,
    byProject: [...projectMap.values()].sort((a, b) => b.cost - a.cost),
    byAgent: [...agentMap.values()].sort((a, b) => b.cost - a.cost),
    daily: [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost]) => ({ date, cost })),
    recentExecutions: logs.slice(0, 50).map((l) => ({
      id: l.id,
      taskId: l.task.id,
      taskTitle: l.task.title,
      projectName: l.task.project?.name ?? null,
      agentName: l.task.agent?.name ?? null,
      actualCostUsd: l.actualCostUsd,
      tokenCount: l.tokenCount,
      finishedAt: l.finishedAt,
    })),
  });
}
