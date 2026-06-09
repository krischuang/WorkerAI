import { prisma } from "@/lib/prisma";
import { sendTaskToTmux, type SSHConfig } from "@/lib/ssh-claude-tmux";
import { withServerDispatchLock } from "@/lib/dispatch-lock";

export type AgentDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "already_running" | "task_not_dispatchable" | "ssh_failed"; detail?: string };

export type DispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "already_running" | "task_not_dispatchable" | "ssh_failed"; detail?: string };

/**
 * Atomically dispatch a task to a server's Claude tmux session.
 *
 * Acquires a per-server lock, then re-verifies both the server is free and
 * the task is still dispatchable before sending. The DB update (status →
 * "running" + ExecutionLog) is committed inside the lock so no other path
 * can dispatch concurrently to the same server.
 */
export async function tryDispatchTaskToServer(opts: {
  taskId: string;
  serverId: string;
  sshConfig: SSHConfig;
  task: { title: string; description?: string | null; projectName?: string | null };
  logText: string;
}): Promise<DispatchOutcome> {
  return withServerDispatchLock(opts.serverId, async () => {
    // Re-verify: no task is already running on this server.
    const runningCount = await prisma.task.count({
      where: { serverId: opts.serverId, status: "running" },
    });
    if (runningCount > 0) return { ok: false, reason: "already_running" as const };

    // Re-verify: the task is still in a state that can be dispatched.
    const current = await prisma.task.findUnique({
      where: { id: opts.taskId },
      select: { status: true },
    });
    if (current?.status !== "queued" && current?.status !== "pending") {
      return { ok: false, reason: "task_not_dispatchable" as const };
    }

    const sendResult = await sendTaskToTmux(opts.sshConfig, opts.task);
    if (!sendResult.success) {
      return { ok: false, reason: "ssh_failed" as const, detail: sendResult.error };
    }

    await prisma.$transaction([
      prisma.task.update({ where: { id: opts.taskId }, data: { status: "running" } }),
      prisma.executionLog.create({
        data: {
          taskId: opts.taskId,
          status: "running",
          startedAt: new Date(),
          logText: opts.logText,
        },
      }),
    ]);

    return { ok: true };
  });
}

/**
 * Atomically dispatch a task to a specific agent's Claude tmux session.
 * Locks on agentId so each agent handles one task at a time independently.
 */
export async function tryDispatchTaskToAgent(opts: {
  taskId: string;
  agentId: string;
  sshConfig: SSHConfig;
  tmuxSession: string;
  task: { title: string; description?: string | null; projectName?: string | null };
  logText: string;
}): Promise<AgentDispatchOutcome> {
  return withServerDispatchLock(opts.agentId, async () => {
    const runningCount = await prisma.task.count({
      where: { agentId: opts.agentId, status: "running" },
    });
    if (runningCount > 0) return { ok: false, reason: "already_running" as const };

    const current = await prisma.task.findUnique({
      where: { id: opts.taskId },
      select: { status: true },
    });
    if (current?.status !== "queued" && current?.status !== "pending") {
      return { ok: false, reason: "task_not_dispatchable" as const };
    }

    const sendResult = await sendTaskToTmux(opts.sshConfig, opts.task, opts.tmuxSession);
    if (!sendResult.success) {
      return { ok: false, reason: "ssh_failed" as const, detail: sendResult.error };
    }

    await prisma.$transaction([
      prisma.task.update({ where: { id: opts.taskId }, data: { status: "running" } }),
      prisma.executionLog.create({
        data: {
          taskId: opts.taskId,
          status: "running",
          startedAt: new Date(),
          logText: opts.logText,
        },
      }),
    ]);

    return { ok: true };
  });
}
