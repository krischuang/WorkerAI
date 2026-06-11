import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const log = await prisma.executionLog.findUnique({
      where: { id },
      include: { task: { select: { id: true, title: true, projectId: true, project: { select: { name: true } } } } },
    });
    if (!log) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(log);
  } catch (err) {
    return serverError("execution-logs/[id] GET", err);
  }
}
