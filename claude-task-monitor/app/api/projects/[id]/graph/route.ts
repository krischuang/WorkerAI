import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/** Returns all tasks + intra-project dependency edges for a project graph view. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const tasks = await prisma.task.findMany({
      where: { projectId: id },
      select: { id: true, title: true, status: true },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });

    const taskIds = tasks.map((t) => t.id);

    // Only return edges where both endpoints belong to this project.
    const edges = await prisma.taskDependency.findMany({
      where: {
        taskId: { in: taskIds },
        dependsOnId: { in: taskIds },
      },
      select: { taskId: true, dependsOnId: true },
    });

    return Response.json({ tasks, edges });
  } catch (err) {
    return serverError("projects/[id]/graph GET", err);
  }
}
