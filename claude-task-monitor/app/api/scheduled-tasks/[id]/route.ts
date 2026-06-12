import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { validateCron, nextCronDate } from "@/lib/cron-schedule";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const st = await prisma.scheduledTask.findUnique({
      where: { id },
      include: { project: { select: { name: true, priority: true } } },
    });
    if (!st) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(st);
  } catch (err) {
    return serverError("scheduled-tasks/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const {
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

    const existing = await prisma.scheduledTask.findUnique({ where: { id } });
    if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

    const newCron = cronSchedule ?? existing.cronSchedule;
    const cronErr = validateCron(newCron);
    if (cronErr) return Response.json({ error: `Invalid cron expression: ${cronErr}` }, { status: 400 });

    const nextRunAt = nextCronDate(newCron);

    const updated = await prisma.scheduledTask.update({
      where: { id },
      data: {
        ...(title != null && { title: title.trim() }),
        ...(description !== undefined && { description: description?.trim() ?? null }),
        ...(cronSchedule != null && { cronSchedule: cronSchedule.trim(), nextRunAt }),
        ...(priority != null && { priority }),
        ...(taskType != null && { taskType }),
        ...(estimatedCostLevel != null && { estimatedCostLevel }),
        ...(timeoutMinutes !== undefined && {
          timeoutMinutes: timeoutMinutes != null ? Number(timeoutMinutes) : null,
        }),
        ...(maxRetries != null && { maxRetries: Number(maxRetries) }),
        ...(enabled !== undefined && { enabled }),
      },
      include: { project: { select: { name: true } } },
    });

    return Response.json(updated);
  } catch (err) {
    return serverError("scheduled-tasks/[id] PUT", err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const existing = await prisma.scheduledTask.findUnique({ where: { id } });
    if (!existing) return Response.json({ error: "Not found" }, { status: 404 });
    await prisma.scheduledTask.delete({ where: { id } });
    return Response.json({ deleted: true });
  } catch (err) {
    return serverError("scheduled-tasks/[id] DELETE", err);
  }
}
