import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

const PRIORITY_ORDER: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

export async function GET() {
  try {
    const tasks = await prisma.task.findMany({
      where: { status: { in: ["pending", "queued"] } },
      include: {
        project: {
          select: { id: true, name: true, priority: true, status: true },
        },
        server: {
          select: { id: true, name: true, host: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Sort by project priority, then task priority, then created time
    tasks.sort((a, b) => {
      const projDiff =
        PRIORITY_ORDER[a.project.priority] - PRIORITY_ORDER[b.project.priority];
      if (projDiff !== 0) return projDiff;
      const taskDiff =
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (taskDiff !== 0) return taskDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return Response.json(tasks);
  } catch (err) {
    return serverError("queue GET", err);
  }
}
