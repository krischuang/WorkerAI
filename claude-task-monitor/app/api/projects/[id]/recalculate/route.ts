import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { recalculateProjectProgress } from "@/lib/project-progress";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exists = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return Response.json({ error: "Not found" }, { status: 404 });

    await recalculateProjectProgress(id);

    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        completionPct: true,
        totalTasks: true,
        completedTasks: true,
        failedTasks: true,
        runningTasks: true,
        pendingTasks: true,
        progressUpdatedAt: true,
        estimatedCompletionAt: true,
      },
    });
    return Response.json(project);
  } catch (err) {
    return serverError("projects/[id]/recalculate POST", err);
  }
}
