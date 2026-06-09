import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { detectClaudeIdle } from "@/lib/ssh-claude-tmux";

export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  const task = await prisma.task.findUnique({
    where: { id },
    include: { server: true },
  });

  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (task.status !== "running") {
    return NextResponse.json({ completed: false, reason: "Task is not running" });
  }
  if (!task.server) {
    return NextResponse.json({ completed: false, reason: "No server assigned" });
  }

  const s = task.server;
  const result = await detectClaudeIdle({
    host: s.host,
    port: s.port,
    username: s.username,
    sshKeyPath: s.sshKeyPath,
  });

  if (result.error) {
    return NextResponse.json({ completed: false, error: result.error });
  }

  if (!result.isIdle) {
    return NextResponse.json({ completed: false });
  }

  // Claude is idle — task has ended. Mark completed and close the execution log.
  const latestLog = await prisma.executionLog.findFirst({
    where: { taskId: id, status: "running", finishedAt: null },
    orderBy: { createdAt: "desc" },
  });

  await prisma.$transaction([
    prisma.task.update({ where: { id }, data: { status: "completed" } }),
    ...(latestLog
      ? [
          prisma.executionLog.update({
            where: { id: latestLog.id },
            data: { status: "completed", finishedAt: new Date() },
          }),
        ]
      : []),
  ]);

  return NextResponse.json({ completed: true });
}
