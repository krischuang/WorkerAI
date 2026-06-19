import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { validateTaskCreate } from "@/lib/task-validation";
import { emitAudit } from "@/lib/audit";
import { recalculateProjectProgress } from "@/lib/project-progress";
import { classifyTaskRisk } from "@/lib/risk-classifier";

const MAX_QUEUED_TASKS_PER_PROJECT = 100;

// Only terminal / non-active statuses may be bulk-deleted.
// Prevents a single API call from wiping running, queued, or pending work.
const BULK_DELETABLE_STATUSES = new Set(["completed", "failed", "archived"]);

// Hard cap per call — prevents a single request from wiping arbitrarily large datasets.
const BULK_DELETE_CAP = 5_000;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");
    const agentId = searchParams.get("agentId");
    const serverId = searchParams.get("serverId");
    const stalled = searchParams.get("stalled") === "true";
    const reviewStatus = searchParams.get("reviewStatus");
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(Math.max(1, parseInt(searchParams.get("limit") ?? "50") || 50), 200);

    const where = {
      ...(projectId && { projectId }),
      ...(status && { status: status as never }),
      ...(agentId && { agentId }),
      ...(serverId && { serverId }),
      // stalled=true: running tasks that have a confirmed stall marker
      ...(stalled && { status: "running", stallDetectedAt: { not: null } }),
      ...(reviewStatus && { reviewStatus: reviewStatus as never }),
    };

    const include = {
      project: { select: { name: true, priority: true } },
      _count: { select: { executionLogs: true } },
      executionLogs: {
        select: { startedAt: true, finishedAt: true, actualCostUsd: true, status: true },
        orderBy: { startedAt: "desc" as const },
        take: 1,
      },
      agent: { select: { id: true, name: true } },
      server: { select: { id: true, name: true } },
    };

    const [tasks, total, completedCount] = await Promise.all([
      prisma.task.findMany({
        where: where as never,
        include,
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.task.count({ where: where as never }),
      prisma.task.count({ where: { status: "completed" } }),
    ]);

    return Response.json({ tasks, total, page, limit, completedCount });
  } catch (err) {
    return serverError("tasks GET", err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const dryRun = searchParams.get("dryRun") === "true";

    if (!status) {
      return Response.json({ error: "status query param is required" }, { status: 400 });
    }

    if (!BULK_DELETABLE_STATUSES.has(status)) {
      return Response.json(
        { error: `status must be one of: ${[...BULK_DELETABLE_STATUSES].join(", ")}` },
        { status: 400 },
      );
    }

    const matchCount = await prisma.task.count({ where: { status: status as never } });

    if (dryRun) {
      return Response.json({ dryRun: true, wouldDelete: matchCount });
    }

    if (matchCount > BULK_DELETE_CAP) {
      return Response.json(
        { error: `Would delete ${matchCount} tasks which exceeds the per-call cap of ${BULK_DELETE_CAP}. Use a more specific filter or contact an administrator.` },
        { status: 422 },
      );
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
      // When true, callers opt out of priority inheritance and always get P3.
      // Useful for seed scripts or bulk imports that supply their own values.
      skipPriorityInherit,
      requiredTags,
      isAutonomous,
    } = body;

    const validationErr = validateTaskCreate(body);
    if (validationErr) {
      return Response.json({ error: validationErr.message }, { status: 400 });
    }

    // Abuse cap: prevent runaway task creation filling a project queue.
    const queuedCount = await prisma.task.count({
      where: { projectId, status: { in: ["pending", "queued"] } },
    });
    if (queuedCount >= MAX_QUEUED_TASKS_PER_PROJECT) {
      return Response.json(
        { error: `Queued task limit reached (${MAX_QUEUED_TASKS_PER_PROJECT} pending/queued per project)` },
        { status: 429 }
      );
    }

    // Priority inheritance: if the caller omitted priority (and did not set
    // skipPriorityInherit=true), inherit it from the parent project so that
    // tasks created under a P1 project don't silently default to P3.
    let resolvedPriority = priority;
    if (!resolvedPriority && !skipPriorityInherit) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { priority: true },
      });
      if (project) resolvedPriority = project.priority;
    }
    resolvedPriority ??= "P3";

    const resolvedRiskLevel = classifyTaskRisk({ title, description, taskType: taskType ?? "coding" });

    const task = await prisma.task.create({
      data: {
        projectId,
        title,
        description,
        priority: resolvedPriority,
        status: status ?? "pending",
        estimatedCostLevel: estimatedCostLevel ?? "medium",
        taskType: taskType ?? "coding",
        riskLevel: resolvedRiskLevel,
        ...(isAutonomous !== undefined && { isAutonomous: Boolean(isAutonomous) }),
        ...(timeoutMinutes != null && { timeoutMinutes: Number(timeoutMinutes) }),
        ...(maxRetries != null && { maxRetries: Number(maxRetries) }),
        ...(Array.isArray(requiredTags) && { requiredTags: requiredTags.map((t: string) => t.trim().toLowerCase()) }),
      },
      include: { project: { select: { name: true } } },
    });
    await emitAudit({
      entityType: "task",
      entityId: task.id,
      eventType: "task.created",
      actorType: "user",
      payload: { projectId, title, priority: task.priority, status: task.status, taskType: task.taskType, riskLevel: task.riskLevel },
    });
    recalculateProjectProgress(task.projectId).catch(() => {});

    return Response.json(task, { status: 201 });
  } catch (err) {
    return serverError("tasks POST", err);
  }
}
