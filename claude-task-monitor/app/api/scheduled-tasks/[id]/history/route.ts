import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export interface ScheduledRunHistory {
  taskId: string;
  triggeredAt: string;  // task.createdAt
  status: string;
  durationMs: number | null;
  title: string;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;

  const scheduled = await prisma.scheduledTask.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!scheduled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const tasks = await prisma.task.findMany({
    where: { scheduledTaskId: id },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      executionLogs: {
        select: { durationMs: true, finishedAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const history: ScheduledRunHistory[] = tasks.map((t) => ({
    taskId: t.id,
    triggeredAt: t.createdAt.toISOString(),
    status: t.status,
    durationMs: t.executionLogs[0]?.durationMs ?? null,
    title: t.title,
  }));

  return NextResponse.json(history);
}
