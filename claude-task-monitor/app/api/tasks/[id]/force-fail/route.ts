import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { forceFailTask } from "@/lib/zombie-detection";
import { killTaskTmuxSession } from "@/lib/ssh-claude-tmux";
import { emitAudit } from "@/lib/audit";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const task = await prisma.task.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        taskTmuxSession: true,
        server: { select: { host: true, port: true, username: true, sshKeyPath: true } },
        agent: { select: { server: { select: { host: true, port: true, username: true, sshKeyPath: true } } } },
      },
    });

    if (!task) return Response.json({ error: "Not found" }, { status: 404 });
    if (task.status === "failed") return Response.json({ error: "Task is already failed" }, { status: 409 });

    const previousStatus = task.status;

    await forceFailTask(id, "Force-failed by operator");

    // Kill per-task tmux session if present.
    if (task.taskTmuxSession) {
      const sshCfg = task.server ?? task.agent?.server ?? null;
      if (sshCfg) {
        await killTaskTmuxSession(sshCfg, id).catch(() => {});
      }
    }

    emitAudit({ entityType: "Task", entityId: id, eventType: "task.force_failed", actorType: "user", payload: { previousStatus, newStatus: "failed" } }).catch(() => {});

    return Response.json({ success: true });
  } catch (err) {
    return serverError("tasks/[id]/force-fail POST", err);
  }
}
