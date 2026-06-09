import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  const status = searchParams.get("status");

  const tasks = await prisma.task.findMany({
    where: {
      ...(projectId && { projectId }),
      ...(status && { status: status as never }),
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
