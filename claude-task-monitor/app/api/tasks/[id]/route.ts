import { prisma } from "@/lib/prisma";
import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "@/lib/task-dispatch";
import { serverError } from "@/lib/api-error";
import { validateTaskUpdate } from "@/lib/task-validation";
import type { NextRequest } from "next/server";
import { USAGE_THRESHOLD } from "@/lib/constants";
import { resolveTaskTimeout, computeTimeoutExpiresAt } from "@/lib/task-timeout";
import { emitAudit } from "@/lib/audit";
import { recalculateProjectProgress } from "@/lib/project-progress";

type Ctx = { params: Promise<{ id: string }> };

const SERVER_USAGE_SELECT = {
  id: true,
  name: true,
  host: true,
  defaultTaskTimeoutMinutes: true,
  claudeSessionPct: true,
  claudeSessionResets: true,
  claudeSessionResetsAt: true,
  claudeWeekPct: true,
  claudeWeekResets: true,
  claudeWeekResetsAt: true,
  claudeUsageFetchedAt: true,
};

const AGENT_USAGE_SELECT = {
  id: true,
  name: true,
  slug: true,
  tmuxSession: true,
  workDir: true,
  status: true,
  claudePermissionMode: true,
  defaultTaskTimeoutMinutes: true,
  claudeSessionPct: true,
  claudeSessionResets: true,
  claudeSessionResetsAt: true,
  claudeWeekPct: true,
  claudeWeekResets: true,
  claudeWeekResetsAt: true,
  claudeUsageFetchedAt: true,
  server: { select: { id: true, name: true, host: true } },
};

const INCLUDE = {
  project: { select: { id: true, name: true, priority: true } },
  server: { select: SERVER_USAGE_SELECT },
  agent: { select: AGENT_USAGE_SELECT },
  executionLogs: { orderBy: { createdAt: "desc" } },
} as const;

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const task = await prisma.task.findUnique({ where: { id }, include: INCLUDE });
    if (!task) return Response.json({ error: "Not found" }, { status: 404 });

    const latestRunningLog = task.executionLogs.find(
      (l) => l.status === "running" && !l.finishedAt
    );
    const timeoutMin = resolveTaskTimeout(
      task.timeoutMinutes,
      task.server?.defaultTaskTimeoutMinutes ?? null,
      task.agent?.defaultTaskTimeoutMinutes ?? null,
    );
    const timeoutExpiresAt = latestRunningLog
      ? computeTimeoutExpiresAt(latestRunningLog.startedAt, timeoutMin)
      : null;

    return Response.json({ ...task, timeoutExpiresAt, resolvedTimeoutMinutes: timeoutMin });
  } catch (err) {
    return serverError("tasks/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const {
      title, description, priority, status, estimatedCostLevel,
      taskType, resultSummary, nextAction, serverId, agentId, timeoutMinutes, maxRetries,
    } = body;

    const validationErr = validateTaskUpdate(body);
    if (validationErr) {
      return Response.json({ error: validationErr.message }, { status: 400 });
    }

    // When assigning an agent, also set serverId from the agent's server for consistency
    let resolvedServerId = serverId;
    if (agentId && agentId !== null) {
      const agent = await prisma.agent.findUnique({
        where: { id: agentId as string },
        select: { serverId: true },
      });
      if (agent) resolvedServerId = agent.serverId;
    }

    const isAssigningAgent = agentId !== undefined && agentId;
    const isAssigningServer = !isAssigningAgent && serverId !== undefined && serverId;
    let autoStatus: "queued" | undefined;

    if ((isAssigningAgent || isAssigningServer) && status === undefined) {
      const current = await prisma.task.findUnique({ where: { id }, select: { status: true } });
      if (current?.status === "pending") autoStatus = "queued";
    }

    let task = await prisma.task.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(priority !== undefined && { priority }),
        ...(status !== undefined && { status }),
        ...(estimatedCostLevel !== undefined && { estimatedCostLevel }),
        ...(taskType !== undefined && { taskType }),
        ...(resultSummary !== undefined && { resultSummary }),
        ...(nextAction !== undefined && { nextAction }),
        ...(agentId !== undefined && { agentId: agentId || null }),
        ...(resolvedServerId !== undefined && { serverId: resolvedServerId || null }),
        ...(serverId !== undefined && agentId === undefined && { serverId: serverId || null }),
        ...(autoStatus && { status: autoStatus }),
        ...(timeoutMinutes !== undefined && { timeoutMinutes: timeoutMinutes === null ? null : Number(timeoutMinutes) }),
        ...(maxRetries !== undefined && { maxRetries: Number(maxRetries) }),
      },
      include: {
        project: { select: { name: true } },
        server: { select: SERVER_USAGE_SELECT },
        agent: { select: AGENT_USAGE_SELECT },
      },
    });

    if (autoStatus === "queued") {
      await emitAudit({
        entityType: "task",
        entityId: id,
        eventType: "task.queued",
        actorType: "user",
        payload: {
          ...(agentId ? { agentId } : {}),
          ...(resolvedServerId ? { serverId: resolvedServerId } : {}),
        },
      });
    }

    // Auto-run: try to send task immediately on assignment
    if (autoStatus === "queued") {
      try {
        if (isAssigningAgent && agentId) {
          const agent = await prisma.agent.findUnique({
            where: { id: agentId as string },
            include: { server: true },
          });

          if (agent) {
            const sessionPct = agent.claudeSessionPct ?? 0;
            const weekPct = agent.claudeWeekPct ?? 0;

            if (sessionPct < USAGE_THRESHOLD && weekPct < USAGE_THRESHOLD) {
              const s = agent.server;
              const outcome = await tryDispatchTaskToAgent({
                taskId: id,
                agentId: agent.id,
                sshConfig: { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
                tmuxSession: agent.tmuxSession,
                task: { title: task.title, description: task.description, projectName: task.project?.name },
                logText: `Auto-sent to agent "${agent.name}" (${agent.tmuxSession}) on server "${s.name}"`,
              });
              if (outcome.ok) {
                await prisma.agent.update({ where: { id: agent.id }, data: { status: "running" } });
                task = await prisma.task.findUnique({ where: { id }, include: { project: { select: { name: true } }, server: { select: SERVER_USAGE_SELECT }, agent: { select: AGENT_USAGE_SELECT } } }) ?? task;
              }
            }
          }
        } else if (isAssigningServer && resolvedServerId) {
          const server = await prisma.server.findUnique({
            where: { id: resolvedServerId as string },
            select: { id: true, name: true, host: true, port: true, username: true, sshKeyPath: true, tmuxSession: true, claudePermissionMode: true, claudeSessionPct: true, claudeWeekPct: true },
          });

          if (server) {
            const sessionPct = server.claudeSessionPct ?? 0;
            const weekPct = server.claudeWeekPct ?? 0;

            if (sessionPct < USAGE_THRESHOLD && weekPct < USAGE_THRESHOLD) {
              const outcome = await tryDispatchTaskToServer({
                taskId: id,
                serverId: server.id,
                sshConfig: { host: server.host, port: server.port, username: server.username, sshKeyPath: server.sshKeyPath },
                permissionMode: server.claudePermissionMode as import("@/lib/ssh-claude-tmux").ClaudePermissionMode,
                task: { title: task.title, description: task.description, projectName: task.project?.name },
                logText: `Auto-sent to Claude on server "${server.name}" (${server.host}) — mode: ${server.claudePermissionMode}`,
              });
              if (outcome.ok) {
                task = await prisma.task.findUnique({ where: { id }, include: { project: { select: { name: true } }, server: { select: SERVER_USAGE_SELECT }, agent: { select: AGENT_USAGE_SELECT } } }) ?? task;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[auto-run] Task ${id}: failed to auto-run:`, err);
      }
    }

    recalculateProjectProgress(task.projectId).catch(() => {});
    return Response.json(task);
  } catch (err) {
    return serverError("tasks/[id] PUT", err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const task = await prisma.task.findUnique({ where: { id }, select: { projectId: true } });
    await prisma.task.delete({ where: { id } });
    if (task?.projectId) recalculateProjectProgress(task.projectId).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("tasks/[id] DELETE", err);
  }
}
