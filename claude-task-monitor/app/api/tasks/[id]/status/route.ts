import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { validateStatusUpdate } from "@/lib/task-validation";
import { validateTransition } from "@/lib/task-transitions";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import type { NextRequest } from "next/server";
import type { $Enums } from "@/app/generated/prisma/client";
import { recalculateProjectProgress } from "@/lib/project-progress";
import { emitNotification } from "@/lib/notification";
import { emitAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // Cap at 10 status updates per minute per task to prevent state-machine
    // thrashing, excessive DB writes, and webhook quota exhaustion.
    const rl = apiRateLimit(`task:status:${id}`, 10, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const { status } = await request.json();

    const validationErr = validateStatusUpdate(status);
    if (validationErr) {
      return Response.json({ error: validationErr.message }, { status: 400 });
    }

    const current = await prisma.task.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const transitionErr = validateTransition(current.status, status as $Enums.TaskStatus);
    if (transitionErr) {
      return Response.json({ error: transitionErr.message }, { status: 422 });
    }

    const previousStatus = current.status;

    const task = await prisma.task.update({
      where: { id },
      data: { status: status as $Enums.TaskStatus },
    });
    if (task.projectId) {
      recalculateProjectProgress(task.projectId).catch(() => {});
    }
    if (status === "completed" || status === "failed") {
      emitNotification(id, status === "completed" ? "task.completed" : "task.failed").catch(() => {});
    }
    emitAudit({ entityType: "Task", entityId: id, eventType: "task.status_changed", actorType: "user", payload: { previousStatus, newStatus: status } }).catch(() => {});
    return Response.json(task);
  } catch (err) {
    return serverError("tasks/[id]/status PUT", err);
  }
}
