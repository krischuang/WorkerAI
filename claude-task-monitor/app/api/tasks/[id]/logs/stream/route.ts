import { prisma } from "@/lib/prisma";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { emitAudit } from "@/lib/audit";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/tasks/[id]/logs/stream
 *
 * Server-Sent Events stream of new ExecutionLog rows for the given task.
 * Streams while the task is in "running" status, then closes.
 *
 * Query params:
 *   cursor — id of the last ExecutionLog the client already has (optional).
 *             Only rows created after that row are sent.
 */
export async function GET(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  // Rate-limit: cap rapid reconnect attempts (e.g. polling loops or probing
  // unknown task IDs) at 30 opens per minute per task.
  const rl = apiRateLimit(`task:logs-stream:${id}`, 30, 60_000);
  if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

  const cursor = request.nextUrl.searchParams.get("cursor") ?? null;

  // Verify the task exists and belongs to a project before opening the stream.
  // Execution logs can contain sensitive SSH output and env var names, so we
  // must not stream them to callers who only know a task UUID from another context.
  const task = await prisma.task.findUnique({
    where: { id },
    select: { status: true, projectId: true },
  });
  if (!task) {
    return new Response("Task not found", { status: 404 });
  }
  // Reject orphaned tasks (projectId should never be null for valid tasks, but
  // guard explicitly so log access always requires a known project association).
  if (!task.projectId) {
    return new Response("Task has no associated project", { status: 403 });
  }

  // Audit: record that a live log stream was opened so operators can review
  // access patterns in the audit log, consistent with other sensitive endpoints.
  emitAudit({
    entityType: "Task",
    entityId: id,
    eventType: "task.log_stream_opened",
    actorType: "user",
    payload: { projectId: task.projectId },
  }).catch(() => { /* non-fatal */ });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastCursor = cursor;
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Poll every second for new logs and task status changes.
      const tick = async () => {
        if (closed) return;

        try {
          const current = await prisma.task.findUnique({
            where: { id },
            select: { status: true },
          });

          if (!current) {
            send("close", { reason: "task_not_found" });
            closed = true;
            controller.close();
            return;
          }

          // Fetch new log rows since the last cursor.
          const newLogs = await prisma.executionLog.findMany({
            where: {
              taskId: id,
              ...(lastCursor
                ? {
                    createdAt: {
                      gt: (
                        await prisma.executionLog.findUnique({
                          where: { id: lastCursor },
                          select: { createdAt: true },
                        })
                      )?.createdAt ?? new Date(0),
                    },
                  }
                : {}),
            },
            orderBy: { createdAt: "asc" },
          });

          for (const log of newLogs) {
            send("log", log);
            lastCursor = log.id;
          }

          // If the task is no longer running, send a final status event and close.
          if (current.status !== "running") {
            send("status", { status: current.status });
            closed = true;
            controller.close();
            return;
          }

          // Schedule next tick.
          if (!closed) setTimeout(tick, 1_000);
        } catch {
          if (!closed) {
            try { controller.close(); } catch { /* ignore */ }
            closed = true;
          }
        }
      };

      // Start polling immediately.
      await tick();
    },

    cancel() {
      // Client disconnected — nothing to clean up; tick loop will stop on next check.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
