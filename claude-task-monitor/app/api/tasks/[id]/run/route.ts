import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { tryDispatchTaskToServer } from "@/lib/task-dispatch";

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

  const outcome = await tryDispatchTaskToServer({
    taskId: id,
    serverId: s.id,
    sshConfig: { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
    task: { title: task.title, description: task.description, projectName: task.project.name },
    logText: `Sent to Claude on server "${s.name}" (${s.host}) — mode: ${s.claudePermissionMode}`,
  });

  if (!outcome.ok) {
    if (outcome.reason === "already_running") {
      return NextResponse.json({ error: "Server already has a running task" }, { status: 409 });
    }
    if (outcome.reason === "task_not_dispatchable") {
      return NextResponse.json({ error: "Task is not in a runnable state" }, { status: 409 });
    }
    return NextResponse.json({ error: outcome.detail ?? "SSH dispatch failed" }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
