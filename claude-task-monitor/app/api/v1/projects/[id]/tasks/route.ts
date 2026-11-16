import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { authenticateServiceAccountRequest, isProjectInScope } from "@/lib/service-account";
import { validateTaskCreate } from "@/lib/task-validation";
import { classifyTaskRisk } from "@/lib/risk-classifier";
import { evaluateTaskContent } from "@/lib/prompt-firewall";
import { emitAudit } from "@/lib/audit";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/projects/[id]/tasks: tasks for a project, scoped. */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const client = await authenticateServiceAccountRequest(req);
    if (!client) {
      return Response.json({ error: "Invalid or revoked API key" }, { status: 401 });
    }

    const { id: projectId } = await ctx.params;
    if (!isProjectInScope(client, projectId)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const tasks = await prisma.task.findMany({
      where: { projectId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        taskType: true,
        riskLevel: true,
        validationStatus: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });

    return Response.json({ tasks });
  } catch (err) {
    return serverError("v1/projects/[id]/tasks GET", err);
  }
}

/**
 * POST /api/v1/projects/[id]/tasks: create a task within a scoped project.
 *
 * Deliberately reuses the same validation (validateTaskCreate), risk
 * classification (classifyTaskRisk), and prompt-firewall screening
 * (evaluateTaskContent) as the internal POST /api/tasks route, a task
 * created through the external surface must be subject to exactly the same
 * safety gates as one created through the UI, not a lighter-weight copy.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const client = await authenticateServiceAccountRequest(req);
    if (!client) {
      return Response.json({ error: "Invalid or revoked API key" }, { status: 401 });
    }

    const { id: projectId } = await ctx.params;
    if (!isProjectInScope(client, projectId)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const body = await req.json();
    const validationError = validateTaskCreate({ ...body, projectId });
    if (validationError) {
      return Response.json({ error: validationError.message, field: validationError.field }, { status: 400 });
    }

    const firewallResult = await evaluateTaskContent({
      taskId: "pending",
      title: body.title,
      description: body.description,
    });
    if (firewallResult.blocked) {
      return Response.json({ error: "Task content blocked by prompt firewall" }, { status: 422 });
    }

    const riskLevel = classifyTaskRisk({
      title: body.title,
      description: body.description,
      taskType: body.taskType,
    });

    const task = await prisma.task.create({
      data: {
        projectId,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? "P3",
        taskType: body.taskType ?? "coding",
        riskLevel,
      },
    });

    await emitAudit({
      entityType: "task",
      entityId: task.id,
      eventType: "task.created_via_api_v1",
      actorType: "service-account",
      payload: { serviceAccountId: client.id, serviceAccountName: client.name },
    });

    return Response.json(task, { status: 201 });
  } catch (err) {
    return serverError("v1/projects/[id]/tasks POST", err);
  }
}
