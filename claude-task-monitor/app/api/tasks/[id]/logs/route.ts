import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const logs = await prisma.executionLog.findMany({
      where: { taskId: id },
      orderBy: { createdAt: "desc" },
    });
    return Response.json(logs);
  } catch (err) {
    return serverError("tasks/[id]/logs GET", err);
  }
}

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const { status, logText, errorMessage, outputSummary, finishedAt } = body;

    if (!status) {
      return Response.json({ error: "status is required" }, { status: 400 });
    }

    const log = await prisma.executionLog.create({
      data: {
        taskId: id,
        status,
        logText,
        errorMessage,
        outputSummary,
        finishedAt: finishedAt ? new Date(finishedAt) : undefined,
      },
    });
    return Response.json(log, { status: 201 });
  } catch (err) {
    return serverError("tasks/[id]/logs POST", err);
  }
}
