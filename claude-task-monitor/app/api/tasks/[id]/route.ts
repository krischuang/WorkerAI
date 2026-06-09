import { prisma } from "@/lib/prisma";
import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "@/lib/task-dispatch";
import { Priority, TaskStatus, CostLevel, TaskType } from "@/app/generated/prisma/client";
import type { NextRequest } from "next/server";

const VALID_PRIORITIES = new Set<string>(Object.values(Priority));
const VALID_STATUSES = new Set<string>(Object.values(TaskStatus));
const VALID_COST_LEVELS = new Set<string>(Object.values(CostLevel));
const VALID_TASK_TYPES = new Set<string>(Object.values(TaskType));

type Ctx = { params: Promise<{ id: string }> };

const SERVER_USAGE_SELECT = {
  id: true,
  name: true,
  host: true,
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
  const { id } = await ctx.params;
  const task = await prisma.task.findUnique({ where: { id }, include: INCLUDE });
  if (!task) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(task);
}

const USAGE_THRESHOLD = 90;

export async function PUT(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await request.json();
  const {
    title, description, priority, status, estimatedCostLevel,
    taskType, resultSummary, nextAction, serverId, agentId,
  } = body;

  if (title != null && typeof title === "string" && title.length > 500) {
    return Response.json({ error: "title must be 500 characters or fewer" }, { status: 400 });
  }
  if (description != null && typeof description === "string" && description.length > 10_000) {
    return Response.json({ error: "description must be 10 000 characters or fewer" }, { status: 400 });
  }
  if (priority != null && !VALID_PRIORITIES.has(priority))
    return Response.json({ error: `Invalid priority. Must be one of: ${[...VALID_PRIORITIES].join(", ")}` }, { status: 400 });
  if (status != null && !VALID_STATUSES.has(status))
    return Response.json({ error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}` }, { status: 400 });
  if (estimatedCostLevel != null && !VALID_COST_LEVELS.has(estimatedCostLevel))
    return Response.json({ error: `Invalid estimatedCostLevel. Must be one of: ${[...VALID_COST_LEVELS].join(", ")}` }, { status: 400 });
  if (taskType != null && !VALID_TASK_TYPES.has(taskType))
    return Response.json({ error: `Invalid taskType. Must be one of: ${[...VALID_TASK_TYPES].join(", ")}` }, { status: 400 });

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
    },
    include: {
      project: { select: { name: true } },
      server: { select: SERVER_USAGE_SELECT },
      agent: { select: AGENT_USAGE_SELECT },
    },
  });

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
          select: { id: true, name: true, host: true, port: true, username: true, sshKeyPath: true, claudePermissionMode: true, claudeSessionPct: true, claudeWeekPct: true },
        });

        if (server) {
          const sessionPct = server.claudeSessionPct ?? 0;
          const weekPct = server.claudeWeekPct ?? 0;

          if (sessionPct < USAGE_THRESHOLD && weekPct < USAGE_THRESHOLD) {
            const outcome = await tryDispatchTaskToServer({
              taskId: id,
              serverId: server.id,
              sshConfig: { host: server.host, port: server.port, username: server.username, sshKeyPath: server.sshKeyPath },
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

  return Response.json(task);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  await prisma.task.delete({ where: { id } });
  return new Response(null, { status: 204 });
}
