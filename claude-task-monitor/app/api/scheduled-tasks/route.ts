import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { validateCron, nextCronDate } from "@/lib/cron-schedule";

const MAX_SCHEDULED_TASKS_PER_PROJECT = 50;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    const scheduledTasks = await prisma.scheduledTask.findMany({
      where: projectId ? { projectId } : undefined,
      include: { project: { select: { name: true, priority: true } } },
      orderBy: { nextRunAt: "asc" },
    });

    return Response.json(scheduledTasks);
  } catch (err) {
    return serverError("scheduled-tasks GET", err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      projectId,
      title,
      description,
      cronSchedule,
      priority,
      taskType,
      estimatedCostLevel,
      timeoutMinutes,
      maxRetries,
      enabled,
    } = body;

    if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
    if (!title?.trim()) return Response.json({ error: "title is required" }, { status: 400 });
    if (!cronSchedule?.trim()) return Response.json({ error: "cronSchedule is required" }, { status: 400 });

    const cronErr = validateCron(cronSchedule);
    if (cronErr) return Response.json({ error: `Invalid cron expression: ${cronErr}` }, { status: 400 });

    const existingCount = await prisma.scheduledTask.count({ where: { projectId } });
    if (existingCount >= MAX_SCHEDULED_TASKS_PER_PROJECT) {
      return Response.json(
        { error: `Scheduled task limit reached (${MAX_SCHEDULED_TASKS_PER_PROJECT} per project)` },
        { status: 429 }
      );
    }

    const nextRunAt = nextCronDate(cronSchedule);

    const st = await prisma.scheduledTask.create({
      data: {
        projectId,
        title: title.trim(),
        description: description?.trim() ?? null,
        cronSchedule: cronSchedule.trim(),
        priority: priority ?? "P3",
        taskType: taskType ?? "coding",
        estimatedCostLevel: estimatedCostLevel ?? "medium",
        ...(timeoutMinutes != null && { timeoutMinutes: Number(timeoutMinutes) }),
        maxRetries: maxRetries != null ? Number(maxRetries) : 0,
        enabled: enabled !== false,
        nextRunAt,
      },
      include: { project: { select: { name: true } } },
    });

    return Response.json(st, { status: 201 });
  } catch (err) {
    return serverError("scheduled-tasks POST", err);
  }
}
