import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { validateTaskCreate } from "@/lib/task-validation";
import { emitAudit } from "@/lib/audit";
import { recalculateProjectProgress } from "@/lib/project-progress";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");
    const agentId = searchParams.get("agentId");
    const serverId = searchParams.get("serverId");
    const stalled = searchParams.get("stalled") === "true";
    const reviewStatus = searchParams.get("reviewStatus");

    const tasks = await prisma.task.findMany({
      where: {
        ...(projectId && { projectId }),
        ...(status && { status: status as never }),
        ...(agentId && { agentId }),
        ...(serverId && { serverId }),
        // stalled=true: running tasks that have a confirmed stall marker
        ...(stalled && { status: "running", stallDetectedAt: { not: null } }),
        ...(reviewStatus && { reviewStatus: reviewStatus as never }),
      },
      include: {
        project: { select: { name: true, priority: true } },
        _count: { select: { executionLogs: true } },
        executionLogs: {
          select: { startedAt: true, finishedAt: true },
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });
    return Response.json(tasks);
  } catch (err) {
    return serverError("tasks GET", err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    if (!status) {
      return Response.json({ error: "status query param is required" }, { status: 400 });
    }

    const { count } = await prisma.task.deleteMany({ where: { status: status as never } });
    return Response.json({ deleted: count });
  } catch (err) {
    return serverError("tasks DELETE", err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      projectId,
      title,
      description,
      priority,
      status,
      estimatedCostLevel,
      taskType,
      timeoutMinutes,
      maxRetries,
    } = body;

    const validationErr = validateTaskCreate(body);
    if (validationErr) {
      return Response.json({ error: validationErr.message }, { status: 400 });
    }

    const task = await prisma.task.create({
      data: {
        projectId,
        title,
        description,
        priority: priority ?? "P3",
        status: status ?? "pending",
        estimatedCostLevel: estimatedCostLevel ?? "medium",
        taskType: taskType ?? "coding",
        ...(timeoutMinutes != null && { timeoutMinutes: Number(timeoutMinutes) }),
        ...(maxRetries != null && { maxRetries: Number(maxRetries) }),
      },
      include: { project: { select: { name: true } } },
    });
    await emitAudit({
      entityType: "task",
      entityId: task.id,
      eventType: "task.created",
      actorType: "user",
      payload: { projectId, title, priority: task.priority, status: task.status, taskType: task.taskType },
    });
    recalculateProjectProgress(task.projectId).catch(() => {});

    return Response.json(task, { status: 201 });
  } catch (err) {
    return serverError("tasks POST", err);
  }
}
