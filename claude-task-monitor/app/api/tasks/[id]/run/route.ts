import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "@/lib/task-dispatch";
import { serverError } from "@/lib/api-error";
import { USAGE_THRESHOLD } from "@/lib/constants";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

function usageBlockResponse(sessionPct: number, weekPct: number, s: {
  claudeSessionResets: string | null;
  claudeWeekResets: string | null;
  claudeSessionResetsAt: Date | null;
  claudeWeekResetsAt: Date | null;
}) {
  const sessionBlocked = sessionPct >= USAGE_THRESHOLD;
  const weekBlocked = weekPct >= USAGE_THRESHOLD;
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

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        server: true,
        project: true,
        agent: { include: { server: true } },
      },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // ── Agent-based dispatch (new path) ──────────────────────────────────────────
    if (task.agent) {
      const a = task.agent;
      const sessionPct = a.claudeSessionPct ?? 0;
      const weekPct = a.claudeWeekPct ?? 0;

      if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
        return usageBlockResponse(sessionPct, weekPct, a);
      }

      const s = a.server;
      const outcome = await tryDispatchTaskToAgent({
        taskId: id,
        agentId: a.id,
        sshConfig: { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
        tmuxSession: a.tmuxSession,
        task: { title: task.title, description: task.description, projectName: task.project.name },
        logText: `Sent to agent "${a.name}" (${a.tmuxSession}) on server "${s.name}" — mode: ${a.claudePermissionMode}`,
      });

      if (!outcome.ok) {
        if (outcome.reason === "already_running") {
          return NextResponse.json({ error: "Agent already has a running task" }, { status: 409 });
        }
        if (outcome.reason === "task_not_dispatchable") {
          return NextResponse.json({ error: "Task is not in a runnable state" }, { status: 409 });
        }
        return NextResponse.json({ error: outcome.detail ?? "SSH dispatch failed" }, { status: 502 });
      }

      await prisma.agent.update({ where: { id: a.id }, data: { status: "running" } });
      return NextResponse.json({ success: true });
    }

    // ── Legacy server-based dispatch ─────────────────────────────────────────────
    if (!task.server) {
      return NextResponse.json(
        { error: "No agent or server assigned to this task" },
        { status: 400 }
      );
    }

    const s = task.server;
    const sessionPct = s.claudeSessionPct ?? 0;
    const weekPct = s.claudeWeekPct ?? 0;

    if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
      return usageBlockResponse(sessionPct, weekPct, s);
    }

    const outcome = await tryDispatchTaskToServer({
      taskId: id,
      serverId: s.id,
      sshConfig: { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
      tmuxSession: s.tmuxSession,
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
  } catch (err) {
    return serverError("tasks/[id]/run POST", err);
  }
}
