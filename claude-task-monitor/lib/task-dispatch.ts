import { prisma } from "@/lib/prisma";
import {
  sendTaskToTmux,
  taskTmuxSessionName,
  type SSHConfig,
  type ClaudePermissionMode,
} from "@/lib/ssh-claude-tmux";
import { withServerDispatchLock } from "@/lib/dispatch-lock";
import { emitAudit } from "@/lib/audit";
import { getDecryptedTaskSecrets } from "@/lib/task-secrets";
import { isSubsystemHalted } from "@/lib/kill-switch";
import { evaluateTaskContent } from "@/lib/prompt-firewall";

export type AgentDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "already_running" | "task_not_dispatchable" | "ssh_failed" | "tmux_missing"; detail?: string };

export type DispatchOutcome =
  | { ok: true }
  | { ok: false; reason: "task_not_dispatchable" | "ssh_failed" | "tmux_missing"; detail?: string };

/**
 * Atomically dispatch a task to a server by sending it into the server's
 * long-lived Claude tmux session (the value stored in server.tmuxSession).
 *
 * No per-task session is created.  Completion is detected by the background
 * poller scanning the tmux pane for the WORKERAI_RESULT block, and — as an
 * explicit finalization step — Claude itself runs the psql command included in
 * the dispatch prompt to update the task status directly.
 *
 * The per-task lock (keyed on taskId) prevents the same task from being
 * dispatched twice concurrently (e.g. Run button + poller race).
 */
export async function tryDispatchTaskToServer(opts: {
  taskId: string;
  serverId: string;
  sshConfig: SSHConfig;
  /** The server's long-lived Claude tmux session name (e.g. "claude"). */
  tmuxSession: string;
  permissionMode: ClaudePermissionMode;
  task: { title: string; description?: string | null; projectName?: string | null; isAutonomous?: boolean };
  logText: string;
  usageSnapshotPct?: number | null;
}): Promise<DispatchOutcome> {
  // Kill switch: block all dispatch when taskDispatch subsystem is halted
  if (await isSubsystemHalted("taskDispatch")) {
    return { ok: false, reason: "task_not_dispatchable" as const };
  }

  // Prompt firewall: scan task content for injection/exfiltration attempts
  const firewallResult = await evaluateTaskContent({
    taskId: opts.taskId,
    title: opts.task.title,
    description: opts.task.description,
  });
  if (firewallResult.blocked) {
    return { ok: false, reason: "task_not_dispatchable" as const };
  }

  return withServerDispatchLock(opts.taskId, async () => {
    const current = await prisma.task.findUnique({
      where: { id: opts.taskId },
      select: { status: true },
    });
    if (current?.status !== "queued" && current?.status !== "pending") {
      return { ok: false, reason: "task_not_dispatchable" as const };
    }

    // Nonce used for WORKERAI_RESULT pane detection.
    const nonce = crypto.randomUUID();

    const taskSecrets = await getDecryptedTaskSecrets(opts.taskId).catch(() => []);
    const envVars = taskSecrets.length > 0
      ? Object.fromEntries(taskSecrets.map(({ key, value }) => [key, value]))
      : undefined;

    const sendResult = await sendTaskToTmux(
      opts.sshConfig,
      { ...opts.task, taskId: opts.taskId, nonce },
      opts.tmuxSession,
      envVars,
    );
    if (!sendResult.success) {
      const err = sendResult.error ?? "";
      if (err.includes("not found")) {
        return { ok: false, reason: "tmux_missing" as const, detail: err };
      }
      return { ok: false, reason: "ssh_failed" as const, detail: err };
    }

    await prisma.$transaction(async (tx) => {
      const taskData = await tx.task.findUnique({
        where: { id: opts.taskId },
        select: { retryCount: true },
      });
      await tx.task.update({
        where: { id: opts.taskId },
        data: {
          status:           "running",
          runId:            null,
          completionNonce:  nonce,
          taskTmuxSession:  null,
          tmuxOutputOffset: sendResult.outputOffset ?? null,
        },
      });
      await tx.executionLog.create({
        data: {
          taskId:           opts.taskId,
          runId:            null,
          status:           "running",
          startedAt:        new Date(),
          logText:          opts.logText,
          retryNumber:      taskData?.retryCount ?? 0,
          usageSnapshotPct: opts.usageSnapshotPct ?? null,
        },
      });
    });

    console.log(
      `[TASK_STARTED] taskId="${opts.taskId}" title="${opts.task.title}" serverId="${opts.serverId}" session="${opts.tmuxSession}" nonce="${nonce}"`,
    );
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.dispatched",
      actorType: "poller",
      payload: { serverId: opts.serverId, session: opts.tmuxSession, nonce },
    });
    return { ok: true };
  });
}

/**
 * Atomically dispatch a task to an agent by sending it into the agent's
 * long-lived Claude tmux session (agent.tmuxSession, e.g. "claude-agent-1").
 *
 * No per-task session is created.  The prompt includes a WORKERAI_RESULT block
 * that the poller scans for, and a psql finalization command that Claude runs
 * directly after completing the task.
 *
 * Locks on agentId so running-count checks are serialised.
 */
export async function tryDispatchTaskToAgent(opts: {
  taskId: string;
  agentId: string;
  sshConfig: SSHConfig;
  /** Agent's long-lived Claude tmux session name (e.g. "claude-agent-1"). */
  tmuxSession: string;
  workDir?: string;
  permissionMode?: ClaudePermissionMode;
  maxConcurrentTasks?: number;
  task: { title: string; description?: string | null; projectName?: string | null; isAutonomous?: boolean };
  logText: string;
  usageSnapshotPct?: number | null;
}): Promise<AgentDispatchOutcome> {
  if (!opts.tmuxSession || !opts.tmuxSession.trim()) {
    return {
      ok: false,
      reason: "tmux_missing" as const,
      detail: "Agent has no tmuxSession configured. Set the tmuxSession field on the agent record.",
    };
  }

  // Kill switch: block all agent execution when subsystem is halted
  if (await isSubsystemHalted("agentExecution")) {
    return { ok: false, reason: "task_not_dispatchable" as const };
  }

  // Prompt firewall: scan for injection/exfiltration before dispatch
  const firewallCheck = await evaluateTaskContent({
    taskId: opts.taskId,
    title: opts.task.title,
    description: opts.task.description,
  });
  if (firewallCheck.blocked) {
    return { ok: false, reason: "task_not_dispatchable" as const };
  }

  const maxConcurrent = opts.maxConcurrentTasks ?? 1;

  return withServerDispatchLock(opts.agentId, async () => {
    const runningCount = await prisma.task.count({
      where: { agentId: opts.agentId, status: "running" },
    });
    if (runningCount >= maxConcurrent) return { ok: false, reason: "already_running" as const };

    const current = await prisma.task.findUnique({
      where: { id: opts.taskId },
      select: { status: true },
    });
    if (current?.status !== "queued" && current?.status !== "pending") {
      return { ok: false, reason: "task_not_dispatchable" as const };
    }

    const nonce = crypto.randomUUID();

    const taskSecrets = await getDecryptedTaskSecrets(opts.taskId).catch(() => []);
    const envVars = taskSecrets.length > 0
      ? Object.fromEntries(taskSecrets.map(({ key, value }) => [key, value]))
      : undefined;

    const sendResult = await sendTaskToTmux(
      opts.sshConfig,
      { ...opts.task, taskId: opts.taskId, nonce },
      opts.tmuxSession,
      envVars,
    );
    if (!sendResult.success) {
      if (sendResult.error?.includes("not found")) {
        await prisma.agent.update({
          where: { id: opts.agentId },
          data: { status: "offline" },
        }).catch(() => {});
        return { ok: false, reason: "tmux_missing" as const, detail: sendResult.error };
      }
      return { ok: false, reason: "ssh_failed" as const, detail: sendResult.error };
    }

    await prisma.$transaction(async (tx) => {
      const taskData = await tx.task.findUnique({
        where: { id: opts.taskId },
        select: { retryCount: true },
      });
      await tx.task.update({
        where: { id: opts.taskId },
        data: {
          status:           "running",
          runId:            null,
          completionNonce:  nonce,
          taskTmuxSession:  undefined,
          tmuxOutputOffset: sendResult.outputOffset ?? null,
        },
      });
      await tx.agent.update({
        where: { id: opts.agentId },
        data: { status: "running", activeTaskCount: { increment: 1 } },
      });
      await tx.executionLog.create({
        data: {
          taskId:           opts.taskId,
          runId:            null,
          status:           "running",
          startedAt:        new Date(),
          logText:          opts.logText,
          retryNumber:      taskData?.retryCount ?? 0,
          usageSnapshotPct: opts.usageSnapshotPct ?? null,
        },
      });
    });

    console.log(
      `[TASK_STARTED] taskId="${opts.taskId}" title="${opts.task.title}" agentId="${opts.agentId}" session="${opts.tmuxSession}" nonce="${nonce}"`,
    );
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.dispatched",
      actorType: "poller",
      payload: { agentId: opts.agentId, session: opts.tmuxSession, nonce },
    });
    return { ok: true };
  });
}

/** Re-exported for callers that need to build the per-task session name (e.g. cleanup utilities). */
export { taskTmuxSessionName };
