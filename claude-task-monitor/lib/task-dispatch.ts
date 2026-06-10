import { prisma } from "@/lib/prisma";
import { sendTaskToTmux, type SSHConfig } from "@/lib/ssh-claude-tmux";
import { withServerDispatchLock } from "@/lib/dispatch-lock";

export type AgentDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "already_running" | "task_not_dispatchable" | "ssh_failed" | "tmux_missing"; detail?: string };

export type DispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "already_running" | "task_not_dispatchable" | "ssh_failed" | "tmux_missing"; detail?: string };

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
  tmuxSession: string;
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

    const sendResult = await sendTaskToTmux(opts.sshConfig, opts.task, opts.tmuxSession);
    if (!sendResult.success) {
      if (sendResult.error?.includes("not found")) {
        return { ok: false, reason: "tmux_missing" as const, detail: sendResult.error };
      }
      return { ok: false, reason: "ssh_failed" as const, detail: sendResult.error };
    }

    // Callback-form transaction gives the adapter a single connection for
    // both writes, preventing "client already executing a query" pg warnings.
    await prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: opts.taskId }, data: { status: "running" } });
      await tx.executionLog.create({
        data: {
          taskId: opts.taskId,
          status: "running",
          startedAt: new Date(),
          logText: opts.logText,
        },
      });
    });

    return { ok: true };
  });
}

/**
 * Atomically dispatch a task to a specific agent's Claude tmux session.
 * Locks on agentId so each agent handles one task at a time independently.
 *
 * Returns tmux_missing if the agent has no tmuxSession configured or if the
 * session does not exist on the server — callers should mark the agent offline.
 */
export async function tryDispatchTaskToAgent(opts: {
  taskId: string;
  agentId: string;
  sshConfig: SSHConfig;
  tmuxSession: string;
  task: { title: string; description?: string | null; projectName?: string | null };
  logText: string;
}): Promise<AgentDispatchOutcome> {
  // Validate before acquiring the lock — no SSH needed for this check.
  if (!opts.tmuxSession || !opts.tmuxSession.trim()) {
    return {
      ok: false,
      reason: "tmux_missing" as const,
      detail: "Agent has no tmuxSession configured. Set the tmuxSession field on the agent record.",
    };
  }

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
      if (sendResult.error?.includes("not found")) {
        // Session is missing — mark agent offline so the poller stops retrying.
        await prisma.agent.update({
          where: { id: opts.agentId },
          data: { status: "offline" },
        }).catch(() => {});
        return { ok: false, reason: "tmux_missing" as const, detail: sendResult.error };
      }
      return { ok: false, reason: "ssh_failed" as const, detail: sendResult.error };
    }

    await prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: opts.taskId }, data: { status: "running" } });
      await tx.executionLog.create({
        data: {
          taskId: opts.taskId,
          status: "running",
          startedAt: new Date(),
          logText: opts.logText,
        },
      });
    });

    return { ok: true };
  });
}
