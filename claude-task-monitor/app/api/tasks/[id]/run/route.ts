import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendTaskToTmux } from "@/lib/ssh-claude-tmux";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const USAGE_THRESHOLD = 90;

export async function POST(_request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  const task = await prisma.task.findUnique({
    where: { id },
    include: { server: true, project: true },
  });

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (!task.server) {
    return NextResponse.json({ error: "No server assigned to this task" }, { status: 400 });
  }

  const s = task.server;
  const sessionPct = s.claudeSessionPct ?? 0;
  const weekPct = s.claudeWeekPct ?? 0;
  const sessionBlocked = sessionPct >= USAGE_THRESHOLD;
  const weekBlocked = weekPct >= USAGE_THRESHOLD;

  if (sessionBlocked || weekBlocked) {
    // Return the nearest reset among whichever metrics are blocked
    const blockedResets: Date[] = [];
    if (sessionBlocked && s.claudeSessionResetsAt) blockedResets.push(s.claudeSessionResetsAt);
    if (weekBlocked && s.claudeWeekResetsAt) blockedResets.push(s.claudeWeekResetsAt);
    const nearestResetsAt =
      blockedResets.length > 0
        ? blockedResets.reduce((a, b) => (a < b ? a : b)).toISOString()
        : null;

    return NextResponse.json({
      blocked: true,
      sessionPct,
      weekPct,
      sessionBlocked,
      weekBlocked,
      sessionResets: s.claudeSessionResets,
      weekResets: s.claudeWeekResets,
      sessionResetsAt: s.claudeSessionResetsAt?.toISOString() ?? null,
      weekResetsAt: s.claudeWeekResetsAt?.toISOString() ?? null,
      nearestResetsAt,
    });
  }

  // Usage OK — send task to Claude in tmux
  const sendResult = await sendTaskToTmux(
    { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
    { title: task.title, description: task.description, projectName: task.project.name }
  );

  if (!sendResult.success) {
    return NextResponse.json({ error: sendResult.error }, { status: 502 });
  }

  // Mark task running + create execution log
  await prisma.$transaction([
    prisma.task.update({ where: { id }, data: { status: "running" } }),
    prisma.executionLog.create({
      data: {
        taskId: id,
        status: "running",
        startedAt: new Date(),
        logText: `Sent to Claude on server "${s.name}" (${s.host}) — mode: ${s.claudePermissionMode}`,
      },
    }),
  ]);

  return NextResponse.json({ success: true });
}
