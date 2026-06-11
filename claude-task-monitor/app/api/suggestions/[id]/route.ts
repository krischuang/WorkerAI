import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { title, description, priority, taskType, estimatedCostLevel, rationale } = body as {
      title?: string;
      description?: string;
      priority?: string;
      taskType?: string;
      estimatedCostLevel?: string;
      rationale?: string;
    };

    const existing = await prisma.taskSuggestion.findUnique({ where: { id } });
    if (!existing) return Response.json({ error: "Not found" }, { status: 404 });
    if (existing.status !== "pending_review") {
      return Response.json({ error: `Cannot edit a ${existing.status} suggestion` }, { status: 400 });
    }

    const updated = await prisma.taskSuggestion.update({
      where: { id },
      data: {
        ...(title != null && { title: title.slice(0, 200) }),
        ...(description != null && { description: description.slice(0, 2000) }),
        ...(priority != null && { priority: priority as never }),
        ...(taskType != null && { taskType: taskType as never }),
        ...(estimatedCostLevel != null && { estimatedCostLevel: estimatedCostLevel as never }),
        ...(rationale != null && { rationale }),
      },
    });
    return Response.json(updated);
  } catch (err) {
    return serverError("suggestions/[id] PUT", err);
  }
}
