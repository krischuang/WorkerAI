import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { emitAudit } from "@/lib/audit";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/tasks/[id]/retry
 *
 * Manual immediate retry: clears retryAfter and resets the task to "queued"
 * so the next poller cycle (or queue advance) will dispatch it right away.
 *
 * Allowed from:
 *   - "failed"  — task failed and has a server/agent assigned
 *   - "queued"  — task is already queued but is stuck waiting for retryAfter
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const task = await prisma.task.findUnique({
      where: { id },
      select: { id: true, status: true, serverId: true, agentId: true, retryAfter: true },
    });

    if (!task) return Response.json({ error: "Not found" }, { status: 404 });

    const isRetryWaiting = task.status === "queued" && task.retryAfter !== null;
    const isFailed = task.status === "failed";

    if (!isFailed && !isRetryWaiting) {
      return Response.json(
        { error: "Task must be in 'failed' state or queued with a pending retryAfter" },
        { status: 409 },
      );
    }

    if (isFailed && !task.serverId && !task.agentId) {
      return Response.json(
        { error: "Task has no server or agent assigned — assign a resource before retrying" },
        { status: 422 },
      );
    }

    const previousStatus = task.status;

    await prisma.task.update({
      where: { id },
      data: { status: "queued", retryAfter: null },
    });

    emitAudit({ entityType: "Task", entityId: id, eventType: "task.retried", actorType: "user", payload: { previousStatus, newStatus: "queued" } }).catch(() => {});

    return Response.json({ success: true });
  } catch (err) {
    return serverError("tasks/[id]/retry POST", err);
  }
}
