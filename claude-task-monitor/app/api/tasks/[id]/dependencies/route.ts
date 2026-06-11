import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { addDependency } from "@/lib/task-dependency";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const [prerequisites, dependents] = await Promise.all([
      prisma.taskDependency.findMany({
        where: { taskId: id },
        include: { dependsOn: { select: { id: true, title: true, status: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.taskDependency.findMany({
        where: { dependsOnId: id },
        include: { task: { select: { id: true, title: true, status: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return Response.json({ prerequisites, dependents });
  } catch (err) {
    return serverError("tasks/[id]/dependencies GET", err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { dependsOnId } = body as { dependsOnId: string };
    if (!dependsOnId) {
      return Response.json({ error: "dependsOnId is required" }, { status: 400 });
    }

    const result = await addDependency(id, dependsOnId);

    if (!result.ok) {
      if (result.reason === "cycle") {
        return Response.json({ error: "Adding this dependency would create a cycle" }, { status: 409 });
      }
      if (result.reason === "self") {
        return Response.json({ error: "A task cannot depend on itself" }, { status: 400 });
      }
      if (result.reason === "not_found") {
        return Response.json({ error: "Task or prerequisite not found" }, { status: 404 });
      }
      if (result.reason === "already_exists") {
        return Response.json({ error: "Dependency already exists" }, { status: 409 });
      }
    }

    const dep = await prisma.taskDependency.findUnique({
      where: { taskId_dependsOnId: { taskId: id, dependsOnId } },
      include: { dependsOn: { select: { id: true, title: true, status: true } } },
    });
    return Response.json(dep, { status: 201 });
  } catch (err) {
    return serverError("tasks/[id]/dependencies POST", err);
  }
}
