import { prisma } from "@/lib/prisma";
import { Priority, TaskStatus, CostLevel, TaskType } from "@/app/generated/prisma/client";

const VALID_PRIORITIES = new Set<string>(Object.values(Priority));
const VALID_STATUSES = new Set<string>(Object.values(TaskStatus));
const VALID_COST_LEVELS = new Set<string>(Object.values(CostLevel));
const VALID_TASK_TYPES = new Set<string>(Object.values(TaskType));

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  const status = searchParams.get("status");
  const agentId = searchParams.get("agentId");
  const serverId = searchParams.get("serverId");

  const tasks = await prisma.task.findMany({
    where: {
      ...(projectId && { projectId }),
      ...(status && { status: status as never }),
      ...(agentId && { agentId }),
      ...(serverId && { serverId }),
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
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  if (!status) {
    return Response.json({ error: "status query param is required" }, { status: 400 });
  }

  const { count } = await prisma.task.deleteMany({ where: { status: status as never } });
  return Response.json({ deleted: count });
}

export async function POST(request: Request) {
  const body = await request.json();
  const {
    projectId,
    title,
    description,
    priority,
    status,
    estimatedCostLevel,
    taskType,
  } = body;

  if (!projectId || !title) {
    return Response.json(
      { error: "projectId and title are required" },
      { status: 400 }
    );
  }
  if (typeof title === "string" && title.length > 500) {
    return Response.json({ error: "title must be 500 characters or fewer" }, { status: 400 });
  }
  if (description != null && typeof description === "string" && description.length > 10_000) {
    return Response.json({ error: "description must be 10 000 characters or fewer" }, { status: 400 });
  }
  if (priority != null && !VALID_PRIORITIES.has(priority))
    return Response.json({ error: `Invalid priority. Must be one of: ${[...VALID_PRIORITIES].join(", ")}` }, { status: 400 });
  if (status != null && !VALID_STATUSES.has(status))
    return Response.json({ error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}` }, { status: 400 });
  if (estimatedCostLevel != null && !VALID_COST_LEVELS.has(estimatedCostLevel))
    return Response.json({ error: `Invalid estimatedCostLevel. Must be one of: ${[...VALID_COST_LEVELS].join(", ")}` }, { status: 400 });
  if (taskType != null && !VALID_TASK_TYPES.has(taskType))
    return Response.json({ error: `Invalid taskType. Must be one of: ${[...VALID_TASK_TYPES].join(", ")}` }, { status: 400 });

  const task = await prisma.task.create({
    data: {
      projectId,
      title,
      description,
      priority: priority ?? "P3",
      status: status ?? "pending",
      estimatedCostLevel: estimatedCostLevel ?? "medium",
      taskType: taskType ?? "coding",
    },
    include: { project: { select: { name: true } } },
  });
  return Response.json(task, { status: 201 });
}
