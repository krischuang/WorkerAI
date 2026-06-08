import { prisma } from "@/lib/prisma";
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

export async function PUT(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await request.json();
  const {
    title, description, priority, status, estimatedCostLevel,
    taskType, resultSummary, nextAction, serverId,
  } = body;

  // When assigning a server, auto-advance pending → queued (but don't override
  // running / completed / failed — those are meaningful states).
  const isAssigningServer = serverId !== undefined && serverId;
  let autoStatus: "queued" | undefined;
  if (isAssigningServer && status === undefined) {
    const current = await prisma.task.findUnique({ where: { id }, select: { status: true } });
    if (current?.status === "pending") autoStatus = "queued";
  }

  const task = await prisma.task.update({
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
  return Response.json(task);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  await prisma.task.delete({ where: { id } });
  return new Response(null, { status: 204 });
}
