import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { decryptSecret } from "@/lib/task-secrets";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/tasks/[id]/progress
 * Body: { percent: number (0-100), message?: string }
 *
 * Called by the agent or SSH session via curl during task execution to report
 * incremental progress. Only accepted while the task is in "running" status.
 *
 * Authentication (one of):
 *   - Session cookie (operator browser UI — validated by middleware)
 *   - Bearer token matching the task's WORKERAI_PROGRESS_TOKEN secret (agent curl calls)
 *
 * To provision a progress token for a task, store a secret via:
 *   POST /api/tasks/${TASK_ID}/secrets  { key: "WORKERAI_PROGRESS_TOKEN", value: "<random>" }
 *
 * Example curl usage from within an agent:
 *   curl -s -X POST http://localhost:3000/api/tasks/${TASK_ID}/progress \
 *     -H "Content-Type: application/json" \
 *     -H "Authorization: Bearer ${WORKERAI_PROGRESS_TOKEN}" \
 *     -d '{"percent":50,"message":"Halfway through analysis"}'
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // Rate limit: 60 updates/min per task to prevent log flooding.
    const rl = apiRateLimit(`task:progress:${id}`, 60, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    // Bearer token auth for agent curl callers (middleware passed them through).
    // Requests without a Bearer header reached here via session cookie (middleware
    // already validated), so no additional check is needed in that case.
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (!process.env.TASK_SECRET_KEY) {
        return Response.json(
          { error: "TASK_SECRET_KEY is not configured — cannot validate progress token" },
          { status: 503 },
        );
      }
      const secret = await prisma.taskSecret.findUnique({
        where: { taskId_key: { taskId: id, key: "WORKERAI_PROGRESS_TOKEN" } },
        select: { encryptedValue: true },
      });
      if (!secret) {
        return Response.json(
          { error: "No WORKERAI_PROGRESS_TOKEN configured for this task" },
          { status: 401 },
        );
      }
      let expected: string;
      try {
        expected = decryptSecret(secret.encryptedValue);
      } catch {
        return Response.json({ error: "Token validation failed" }, { status: 401 });
      }
      if (token !== expected) {
        return Response.json({ error: "Invalid progress token" }, { status: 401 });
      }
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "Request body must be JSON" }, { status: 400 });
    }

    const { percent, message } = body as { percent?: unknown; message?: unknown };

    if (percent === undefined || percent === null) {
      return Response.json({ error: "percent is required" }, { status: 400 });
    }
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      return Response.json({ error: "percent must be a number" }, { status: 400 });
    }
    const pct = Math.round(percent);
    if (pct < 0 || pct > 100) {
      return Response.json({ error: "percent must be between 0 and 100" }, { status: 400 });
    }
    if (message !== undefined && message !== null && typeof message !== "string") {
      return Response.json({ error: "message must be a string" }, { status: 400 });
    }

    const task = await prisma.task.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!task) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    if (task.status !== "running") {
      return Response.json(
        { error: `Progress updates are only accepted for running tasks (current status: ${task.status})` },
        { status: 422 },
      );
    }

    const updated = await prisma.task.update({
      where: { id },
      data: {
        progressPercent: pct,
        progressMessage: typeof message === "string" ? message.slice(0, 500) : null,
        lastProgressAt: new Date(),
      },
      select: { id: true, progressPercent: true, progressMessage: true, lastProgressAt: true },
    });

    return Response.json(updated);
  } catch (err) {
    return serverError("tasks/[id]/progress POST", err);
  }
}
