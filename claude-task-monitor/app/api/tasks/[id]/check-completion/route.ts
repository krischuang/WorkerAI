import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { detectClaudeIdle } from "@/lib/ssh-claude-tmux";

export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      server: true,
      agent: { include: { server: true } },
    },
  });

  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (task.status !== "running") {
    return NextResponse.json({ completed: false, reason: "Task is not running" });
  }

  let sshConfig: { host: string; port: number; username: string; sshKeyPath: string };
  let tmuxSession: string;
  let agentId: string | null = null;

  if (task.agent) {
    const s = task.agent.server;
    sshConfig = { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath };
    tmuxSession = task.agent.tmuxSession;
    agentId = task.agent.id;
  } else if (task.server) {
    const s = task.server;
    sshConfig = { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath };
    tmuxSession = "claude";
  } else {
    return NextResponse.json({ completed: false, reason: "No agent or server assigned" });
  }

  const result = await detectClaudeIdle(sshConfig, tmuxSession);

  if (result.error) {
    return NextResponse.json({ completed: false, error: result.error });
  }

  if (!result.isIdle) {
    return NextResponse.json({ completed: false });
  }

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
    ...(agentId
      ? [prisma.agent.update({ where: { id: agentId }, data: { status: "idle" } })]
      : []),
  ]);

  return NextResponse.json({ completed: true });
}
