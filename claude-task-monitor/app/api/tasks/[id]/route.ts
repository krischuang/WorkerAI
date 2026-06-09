import { prisma } from "@/lib/prisma";
import { tryDispatchTaskToServer } from "@/lib/task-dispatch";
import type { NextRequest } from "next/server";

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

const INCLUDE = {
  project: { select: { id: true, name: true, priority: true } },
  server: { select: SERVER_USAGE_SELECT },
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
    taskType, resultSummary, nextAction, serverId,
  } = body;

  if (title != null && typeof title === "string" && title.length > 500) {
    return Response.json({ error: "title must be 500 characters or fewer" }, { status: 400 });
  }
  if (description != null && typeof description === "string" && description.length > 10_000) {
    return Response.json({ error: "description must be 10 000 characters or fewer" }, { status: 400 });
  }

  // When assigning a server, auto-advance pending → queued (but don't override
  // running / completed / failed — those are meaningful states).
  const isAssigningServer = serverId !== undefined && serverId;
  let autoStatus: "queued" | undefined;
  if (isAssigningServer && status === undefined) {
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
      ...(serverId !== undefined && { serverId: serverId || null }),
      ...(autoStatus && { status: autoStatus }),
    },
    include: { project: { select: { name: true } }, server: { select: SERVER_USAGE_SELECT } },
  });

  // Auto-run: if task just became queued, immediately try to send it to Claude
  // if usage is below threshold. The dispatch helper acquires a per-server lock
  // and re-checks running count inside it, preventing races with the poller.
  if (autoStatus === "queued" && serverId) {
    try {
      const server = await prisma.server.findUnique({
        where: { id: serverId as string },
        select: {
          id: true, name: true, host: true, port: true,
          username: true, sshKeyPath: true, claudePermissionMode: true,
          claudeSessionPct: true, claudeWeekPct: true,
        },
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
            // Re-fetch with updated status
            task = await prisma.task.findUnique({
              where: { id },
              include: { project: { select: { name: true } }, server: { select: SERVER_USAGE_SELECT } },
            }) ?? task;
          }
        }
      }
    } catch (err) {
      // Auto-run failure is non-fatal — task stays queued and poller will retry
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
