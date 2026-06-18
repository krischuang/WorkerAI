import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { emitAudit } from "@/lib/audit";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/tasks/[id]/clone
 *
 * Duplicates a task, copying descriptive fields only. Runtime state
 * (serverId, agentId, status, executionLogs, retryCount, etc.) is reset.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const rl = apiRateLimit(`task:clone:${id}`, 10, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const source = await prisma.task.findUnique({
      where: { id },
      select: {
        projectId: true,
        title: true,
        description: true,
        priority: true,
        taskType: true,
        estimatedCostLevel: true,
        timeoutMinutes: true,
        maxRetries: true,
        disablePaneCapture: true,
      },
    });

    if (!source) return Response.json({ error: "Not found" }, { status: 404 });

    const clone = await prisma.task.create({
      data: {
        projectId:         source.projectId,
        title:             `${source.title} (copy)`,
        description:       source.description,
        priority:          source.priority as never,
        taskType:          source.taskType as never,
        estimatedCostLevel: source.estimatedCostLevel as never,
        timeoutMinutes:    source.timeoutMinutes,
        maxRetries:        source.maxRetries,
        disablePaneCapture: source.disablePaneCapture,
        status:            "pending",
      },
      select: { id: true, title: true },
    });

    await emitAudit({
      entityType: "Task",
      entityId: clone.id,
      eventType: "task.cloned",
      actorType: "user",
      payload: { sourceTaskId: id },
    });

    return Response.json(clone, { status: 201 });
  } catch (err) {
    return serverError("tasks/[id]/clone POST", err);
  }
}
