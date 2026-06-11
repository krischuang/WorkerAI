import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { applyTemplateVariables } from "@/lib/task-templates";
import { emitAudit } from "@/lib/audit";
import { recalculateProjectProgress } from "@/lib/project-progress";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const template = await prisma.taskTemplate.findUnique({ where: { id } });
    if (!template) return Response.json({ error: "Template not found" }, { status: 404 });

    const body = await request.json();
    const { projectId, variables = {} } = body;

    if (!projectId) {
      return Response.json({ error: "projectId is required" }, { status: 400 });
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

    const title = applyTemplateVariables(template.titleTemplate, variables);
    const description = applyTemplateVariables(template.descriptionTemplate, variables);

    const task = await prisma.task.create({
      data: {
        projectId,
        title,
        description,
        priority: template.priority,
        status: "pending",
        estimatedCostLevel: template.estimatedCostLevel,
        taskType: template.taskType,
      },
      include: { project: { select: { name: true } } },
    });

    await prisma.taskTemplate.update({
      where: { id },
      data: { usageCount: { increment: 1 } },
    });

    await emitAudit({
      entityType: "task",
      entityId: task.id,
      eventType: "task.created",
      actorType: "user",
      payload: {
        projectId,
        title: task.title,
        priority: task.priority,
        status: task.status,
        taskType: task.taskType,
        fromTemplate: template.name,
        templateId: id,
      },
    });
    recalculateProjectProgress(projectId).catch(() => {});

    return Response.json(task, { status: 201 });
  } catch (err) {
    return serverError("task-templates/[id]/use POST", err);
  }
}
