import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true, priority: true } },
      executionLogs: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!task) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(task);
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await request.json();
  const {
    title,
    description,
    priority,
    status,
    estimatedCostLevel,
    taskType,
    resultSummary,
    nextAction,
  } = body;

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
    },
    include: { project: { select: { name: true } } },
  });
  return Response.json(task);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  await prisma.task.delete({ where: { id } });
  return new Response(null, { status: 204 });
}
