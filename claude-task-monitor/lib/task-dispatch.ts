import { prisma } from "@/lib/prisma";
import {
  sendTaskToTmux,
  createAndLaunchTaskSession,
  killTaskTmuxSession,
  taskTmuxSessionName,
  type SSHConfig,
  type ClaudePermissionMode,
} from "@/lib/ssh-claude-tmux";
import { withServerDispatchLock } from "@/lib/dispatch-lock";

export type AgentDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "already_running" | "task_not_dispatchable" | "ssh_failed" | "tmux_missing"; detail?: string };

export type DispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "task_not_dispatchable" | "ssh_failed" | "tmux_missing"; detail?: string };

/**
 * Atomically dispatch a task to a server using a dedicated per-task tmux
 * session (claude_<taskId>).
 *
 * Each task gets its own isolated Claude session, so multiple tasks can run
 * in parallel on the same server without sharing a session or blocking each
 * other.  The `already_running` constraint has been removed — throughput is
 * now limited only by the server's CPU/memory and Claude usage quota.
 *
 * On success the task row is updated with:
 *   - status:          "running"
 *   - taskTmuxSession: "claude_<taskId>"
 *   - completionNonce: a fresh UUID for structured completion detection
 *   - tmuxOutputOffset: pre-dispatch line count for scan windowing
 *
 * The per-task lock (keyed on taskId) prevents the same task from being
 * dispatched twice concurrently (e.g. Run button + poller race).
 */
export async function tryDispatchTaskToServer(opts: {
  taskId: string;
  serverId: string;
  sshConfig: SSHConfig;
  permissionMode: ClaudePermissionMode;
  task: { title: string; description?: string | null; projectName?: string | null };
  logText: string;
}): Promise<DispatchOutcome> {
  // Lock per task (not per server) — sessions are independent so we only need
  // to prevent the same task from being dispatched twice simultaneously.
  return withServerDispatchLock(opts.taskId, async () => {
    // Re-verify: the task is still in a state that can be dispatched.
    const current = await prisma.task.findUnique({
      where: { id: opts.taskId },
      select: { status: true },
    });
    if (current?.status !== "queued" && current?.status !== "pending") {
      return { ok: false, reason: "task_not_dispatchable" as const };
    }

    // Create an isolated tmux session for this task and launch Claude inside.
    const launchResult = await createAndLaunchTaskSession(
      opts.sshConfig,
      opts.taskId,
      opts.permissionMode,
    );
    if (!launchResult.success) {
      return { ok: false, reason: "ssh_failed" as const, detail: launchResult.error };
    }

    const sessionName = launchResult.sessionName; // "claude_<taskId>"

    const nonce = crypto.randomUUID();
    const sendResult = await sendTaskToTmux(
      opts.sshConfig,
      { ...opts.task, taskId: opts.taskId, nonce },
      sessionName,
    );
    if (!sendResult.success) {
      // Clean up the session we just created before returning failure.
      await killTaskTmuxSession(opts.sshConfig, opts.taskId);
      if (sendResult.error?.includes("not found")) {
        return { ok: false, reason: "tmux_missing" as const, detail: sendResult.error };
      }
      return { ok: false, reason: "ssh_failed" as const, detail: sendResult.error };
    }

    // Callback-form transaction gives the adapter a single connection for
    // both writes, preventing "client already executing a query" pg warnings.
    await prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: opts.taskId },
        data: {
          status: "running",
          completionNonce: nonce,
          tmuxOutputOffset: sendResult.outputOffset ?? null,
          taskTmuxSession: sessionName,
        },
      });
      await tx.executionLog.create({
        data: {
          taskId: opts.taskId,
          status: "running",
          startedAt: new Date(),
          logText: opts.logText,
        },
      });
    });

    console.log(
      `[TASK_STARTED] taskId="${opts.taskId}" title="${opts.task.title}" serverId="${opts.serverId}" session="${sessionName}"`,
    );
    return { ok: true };
  });
}

/**
 * Atomically dispatch a task to a specific agent's Claude tmux session.
 * Locks on agentId so each agent handles one task at a time independently.
 *
 * Agents already have per-agent tmux sessions, so no per-task session is
 * created here.  The agent's configured tmuxSession is used directly.
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

    const nonce = crypto.randomUUID();
    const sendResult = await sendTaskToTmux(
      opts.sshConfig,
      { ...opts.task, taskId: opts.taskId, nonce },
      opts.tmuxSession,
    );
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
      await tx.task.update({
        where: { id: opts.taskId },
        data: {
          status: "running",
          completionNonce: nonce,
          tmuxOutputOffset: sendResult.outputOffset ?? null,
        },
      });
      await tx.agent.update({ where: { id: opts.agentId }, data: { status: "running" } });
      await tx.executionLog.create({
        data: {
          taskId: opts.taskId,
          status: "running",
          startedAt: new Date(),
          logText: opts.logText,
        },
      });
    });

    console.log(
      `[TASK_STARTED] taskId="${opts.taskId}" title="${opts.task.title}" agentId="${opts.agentId}"`,
    );
    return { ok: true };
  });
}

/** Exported for callers (e.g. task-service) that need to build the session name. */
export { taskTmuxSessionName };
