import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { detectClaudeIdle, killTaskTmuxSession } from "@/lib/ssh-claude-tmux";
import { serverError } from "@/lib/api-error";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { unblockDependents } from "@/lib/task-dependency";

export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // Each call opens an SSH connection; cap at 12 per minute per task.
    const rl = apiRateLimit(`task:check-completion:${id}`, 12, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        server: true,
        agent: { include: { server: true } },
      },
    });

    if (!task) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (task.status !== "running") {
      return NextResponse.json({ completed: false, reason: "Task is not running" });
    }

    let sshConfig: { host: string; port: number; username: string; sshKeyPath: string };
    let tmuxSession: string;
    let agentId: string | null = null;
    let isPerTaskSession = false;

    if (task.agent) {
      const s = task.agent.server;
      sshConfig = { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath };
      tmuxSession = task.agent.tmuxSession;
      agentId = task.agent.id;
    } else if (task.server) {
      const s = task.server;
      sshConfig = { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath };
      // Use the per-task session if present (new parallel execution model).
      // Fall back to the server's shared session for legacy tasks dispatched
      // before per-task sessions were introduced.
      if (task.taskTmuxSession) {
        tmuxSession = task.taskTmuxSession;
        isPerTaskSession = true;
      } else {
        tmuxSession = s.tmuxSession;
      }
    } else {
      return NextResponse.json({ completed: false, reason: "No agent or server assigned" });
    }

    const result = await detectClaudeIdle(sshConfig, tmuxSession);

    if (result.error) {
      return NextResponse.json({ completed: false, error: result.error });
    }

    if (!result.isIdle) {
      return NextResponse.json({ completed: false });
    }

    const latestLog = await prisma.executionLog.findFirst({
      where: { taskId: id, status: "running", finishedAt: null },
      orderBy: { createdAt: "desc" },
    });

    await prisma.$transaction([
      prisma.task.update({ where: { id }, data: { status: "completed" } }),
      ...(latestLog
        ? [
            prisma.executionLog.update({
              where: { id: latestLog.id },
              data: { status: "completed", finishedAt: new Date() },
            }),
          ]
        : []),
      ...(agentId
        ? [prisma.agent.update({ where: { id: agentId }, data: { status: "idle" } })]
        : []),
    ]);

    // Clean up the per-task tmux session now that the task is complete.
    if (isPerTaskSession) {
      await killTaskTmuxSession(sshConfig, id);
    }

    unblockDependents(id).catch(() => {});
    return NextResponse.json({ completed: true });
  } catch (err) {
    return serverError("tasks/[id]/check-completion POST", err);
  }
}
