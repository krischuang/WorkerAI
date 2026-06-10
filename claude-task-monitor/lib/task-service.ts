/**
 * Service layer for task lifecycle operations.
 *
 * Extracts business logic that was previously scattered across API route
 * handlers (tasks/[id]/run, tasks/[id]/review) and the background poller
 * (instrumentation.node.ts).  Routes and the poller become thin callers that
 * invoke these functions and translate the typed results into HTTP responses or
 * log entries.
 *
 * All three exported functions are framework-agnostic: they accept plain
 * arguments and return plain objects — no NextRequest/NextResponse dependency.
 */

import { prisma } from "@/lib/prisma";
import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "@/lib/task-dispatch";
import { detectClaudeIdle, sendRawPromptToTmux } from "@/lib/ssh-claude-tmux";
// detectClaudeIdle is used in _advanceAgentQueue (agents still need idle check)
import { withServerDispatchLock } from "@/lib/dispatch-lock";
import { buildReviewPrompt } from "@/lib/prompt-sanitiser";
import { execSSH, type ServerConfig } from "@/lib/ssh";
import { cleanPane } from "@/lib/usage-parser";
import { USAGE_THRESHOLD } from "@/lib/constants";
import {
  shouldSkipDueToBackoff,
  recordDispatchFailure,
  clearDispatchBackoff,
  type BackoffEntry,
} from "@/lib/dispatch-backoff";

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * Usage-limit details returned when a dispatch is blocked by Claude quota.
 * Mirrors the shape currently built inline in the run route.
 */
export interface UsageBlockInfo {
  sessionPct: number;
  weekPct: number;
  sessionBlocked: boolean;
  weekBlocked: boolean;
  sessionResets: string | null;
  weekResets: string | null;
  sessionResetsAt: string | null;
  weekResetsAt: string | null;
  nearestResetsAt: string | null;
}

// ─── dispatchTask ─────────────────────────────────────────────────────────────

export type DispatchResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "no_resource" }
  | { ok: false; reason: "usage_blocked"; usageInfo: UsageBlockInfo }
  | { ok: false; reason: "already_running"; entity: "server" | "agent" }
  | { ok: false; reason: "not_dispatchable" }
  | { ok: false; reason: "ssh_failed" | "tmux_missing"; detail?: string };

/**
 * Build a UsageBlockInfo object from cached usage fields on a server or agent.
 * Exported so callers can introspect usage details without duplicating logic.
 */
export function buildUsageBlockInfo(
  sessionPct: number,
  weekPct: number,
  resource: {
    claudeSessionResets: string | null;
    claudeWeekResets: string | null;
    claudeSessionResetsAt: Date | null;
    claudeWeekResetsAt: Date | null;
  },
): UsageBlockInfo {
  const sessionBlocked = sessionPct >= USAGE_THRESHOLD;
  const weekBlocked = weekPct >= USAGE_THRESHOLD;
  const blockedResets: Date[] = [];
  if (sessionBlocked && resource.claudeSessionResetsAt) blockedResets.push(resource.claudeSessionResetsAt);
  if (weekBlocked && resource.claudeWeekResetsAt) blockedResets.push(resource.claudeWeekResetsAt);
  const nearestResetsAt =
    blockedResets.length > 0
      ? blockedResets.reduce((a, b) => (a < b ? a : b)).toISOString()
      : null;

  return {
    sessionPct,
    weekPct,
    sessionBlocked,
    weekBlocked,
    sessionResets: resource.claudeSessionResets,
    weekResets: resource.claudeWeekResets,
    sessionResetsAt: resource.claudeSessionResetsAt?.toISOString() ?? null,
    weekResetsAt: resource.claudeWeekResetsAt?.toISOString() ?? null,
    nearestResetsAt,
  };
}

/**
 * Dispatch a queued/pending task to whichever server or agent it is assigned
 * to.  Enforces usage thresholds and delegates to the atomic dispatch
 * functions in lib/task-dispatch.ts.
 *
 * Call sites: POST /api/tasks/[id]/run
 */
export async function dispatchTask(taskId: string): Promise<DispatchResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      server: true,
      project: true,
      agent: { include: { server: true } },
    },
  });

  if (!task) return { ok: false, reason: "not_found" };

  // ── Agent path ───────────────────────────────────────────────────────────────
  if (task.agent) {
    const a = task.agent;
    const sessionPct = a.claudeSessionPct ?? 0;
    const weekPct = a.claudeWeekPct ?? 0;

    if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
      return { ok: false, reason: "usage_blocked", usageInfo: buildUsageBlockInfo(sessionPct, weekPct, a) };
    }

    const s = a.server;
    const outcome = await tryDispatchTaskToAgent({
      taskId,
      agentId: a.id,
      sshConfig: { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
      tmuxSession: a.tmuxSession,
      task: { title: task.title, description: task.description, projectName: task.project.name },
      logText: `Sent to agent "${a.name}" (${a.tmuxSession}) on server "${s.name}" — mode: ${a.claudePermissionMode}`,
    });

    if (!outcome.ok) {
      if (outcome.reason === "already_running") return { ok: false, reason: "already_running", entity: "agent" };
      if (outcome.reason === "task_not_dispatchable") return { ok: false, reason: "not_dispatchable" };
      return { ok: false, reason: outcome.reason as "ssh_failed" | "tmux_missing", detail: outcome.detail };
    }

    return { ok: true };
  }

  // ── Server path ──────────────────────────────────────────────────────────────
  if (!task.server) return { ok: false, reason: "no_resource" };

  const s = task.server;
  const sessionPct = s.claudeSessionPct ?? 0;
  const weekPct = s.claudeWeekPct ?? 0;

  if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
    return { ok: false, reason: "usage_blocked", usageInfo: buildUsageBlockInfo(sessionPct, weekPct, s) };
  }

  const outcome = await tryDispatchTaskToServer({
    taskId,
    serverId: s.id,
    sshConfig: { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
    permissionMode: s.claudePermissionMode as import("@/lib/ssh-claude-tmux").ClaudePermissionMode,
    task: { title: task.title, description: task.description, projectName: task.project.name },
    logText: `Sent to Claude on server "${s.name}" (${s.host}) — mode: ${s.claudePermissionMode}`,
  });

  if (!outcome.ok) {
    if (outcome.reason === "task_not_dispatchable") return { ok: false, reason: "not_dispatchable" };
    return { ok: false, reason: outcome.reason as "ssh_failed" | "tmux_missing", detail: outcome.detail };
  }

  return { ok: true };
}

// ─── reviewTask ───────────────────────────────────────────────────────────────

export type ReviewResult =
  | { ok: true; verdict: "done"; newStatus: "archived" }
  | { ok: true; verdict: "incomplete"; newStatus: "pending" }
  | { ok: true; verdict: null } // timed out — no verdict from Claude
  | { ok: false; reason: "not_found" | "not_completed" | "no_server" | "server_busy" }
  | { ok: false; reason: "ssh_failed"; detail?: string };

const REVIEW_POLL_INTERVAL_MS = 10_000;
const REVIEW_POLL_TIMEOUT_MS  = 50_000;

async function pollForVerdict(
  ssh: ServerConfig,
  tmuxSession: string,
  timeoutMs: number,
): Promise<"done" | "incomplete" | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, REVIEW_POLL_INTERVAL_MS));

    try {
      const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${tmuxSession} -p`, 5_000);
      const pane = cleanPane(stdout);
      const verdictMatch = pane.match(/VERDICT:\s*(done|incomplete)/i);
      if (verdictMatch) {
        return verdictMatch[1].toLowerCase() === "done" ? "done" : "incomplete";
      }
    } catch {
      // SSH hiccup — keep polling until the deadline
    }
  }

  return null;
}

/**
 * Send a review prompt to the Claude session for a completed task and wait for
 * the VERDICT response.  Holds the server dispatch lock throughout so no new
 * task can corrupt the session while Claude is replying.
 *
 * Call sites: POST /api/tasks/[id]/review
 */
export async function reviewTask(taskId: string): Promise<ReviewResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      server: true,
      executionLogs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  if (!task) return { ok: false, reason: "not_found" };
  if (task.status !== "completed") return { ok: false, reason: "not_completed" };
  if (!task.server) return { ok: false, reason: "no_server" };

  const s = task.server;
  const latestLog = task.executionLogs[0] ?? null;

  const reviewPrompt = buildReviewPrompt({
    title: task.title,
    description: task.description,
    resultSummary: task.resultSummary,
    outputSummary: latestLog?.outputSummary,
    logText: latestLog?.logText,
  });

  const ssh: ServerConfig = {
    host: s.host,
    port: s.port,
    username: s.username,
    sshKeyPath: s.sshKeyPath,
  };

  type LockOutcome =
    | { ok: true; verdict: "done" | "incomplete" | null }
    | { ok: false; reason: "server_busy" | "ssh_failed"; detail?: string };

  const lockOutcome = await withServerDispatchLock<LockOutcome>(s.id, async () => {
    const runningCount = await prisma.task.count({
      where: { serverId: s.id, status: "running" },
    });
    if (runningCount > 0) {
      return { ok: false, reason: "server_busy" } as const;
    }

    const sendResult = await sendRawPromptToTmux(
      { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
      reviewPrompt,
      s.tmuxSession,
    );
    if (!sendResult.success) {
      return { ok: false, reason: "ssh_failed", detail: sendResult.error } as const;
    }

    const verdict = await pollForVerdict(ssh, s.tmuxSession, REVIEW_POLL_TIMEOUT_MS);
    return { ok: true, verdict } as const;
  });

  if (!lockOutcome.ok) return lockOutcome;

  const { verdict } = lockOutcome;

  if (verdict === "done") {
    await prisma.task.update({ where: { id: taskId }, data: { status: "archived" } });
    return { ok: true, verdict: "done", newStatus: "archived" };
  }
  if (verdict === "incomplete") {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: "pending", resultSummary: null },
    });
    return { ok: true, verdict: "incomplete", newStatus: "pending" };
  }

  return { ok: true, verdict: null };
}

// ─── checkAndAdvanceQueue ─────────────────────────────────────────────────────

/**
 * Discriminated reference to the resource (server or agent) whose queue should
 * be advanced.
 */
export type QueueResourceRef =
  | { type: "server"; id: string }
  | { type: "agent"; id: string };

export type QueueAdvanceResult =
  | { dispatched: true; taskId: string }
  | { dispatched: false; reason: "no_queued_tasks" | "usage_blocked" | "not_idle" | "offline" | "backoff" | "ssh_failed" | "tmux_missing" };

/**
 * Check whether the target server or agent is idle and under quota, then
 * dispatch the highest-priority queued task if one exists.
 *
 * The `backoff` map is passed by the caller so this function can be used from
 * both the background poller (which holds a long-lived map) and API routes
 * (which can supply an empty map to skip backoff).
 *
 * Call sites: instrumentation.node.ts steps 3 & 4, and any future API trigger.
 */
export async function checkAndAdvanceQueue(
  resource: QueueResourceRef,
  backoff: Map<string, BackoffEntry>,
): Promise<QueueAdvanceResult> {
  return resource.type === "server"
    ? _advanceServerQueue(resource.id, backoff)
    : _advanceAgentQueue(resource.id, backoff);
}

async function _advanceServerQueue(
  serverId: string,
  backoff: Map<string, BackoffEntry>,
): Promise<QueueAdvanceResult> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: {
      id: true,
      name: true,
      host: true,
      port: true,
      username: true,
      sshKeyPath: true,
      claudePermissionMode: true,
      claudeSessionPct: true,
      claudeWeekPct: true,
    },
  });

  if (!server) return { dispatched: false, reason: "offline" };

  const sessionPct = server.claudeSessionPct ?? 0;
  const weekPct = server.claudeWeekPct ?? 0;

  if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
    return { dispatched: false, reason: "usage_blocked" };
  }

  // Per-task sessions mean tasks run in parallel — no idle check needed.
  // Each dispatch creates its own claude_<taskId> session independently.

  const nextTask = await prisma.task.findFirst({
    where: { serverId, status: "queued", agentId: null },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: { project: { select: { name: true } } },
  });

  if (!nextTask) return { dispatched: false, reason: "no_queued_tasks" };

  if (shouldSkipDueToBackoff(nextTask.id, backoff)) {
    return { dispatched: false, reason: "backoff" };
  }

  const outcome = await tryDispatchTaskToServer({
    taskId: nextTask.id,
    serverId,
    sshConfig: { host: server.host, port: server.port, username: server.username, sshKeyPath: server.sshKeyPath },
    permissionMode: server.claudePermissionMode as import("@/lib/ssh-claude-tmux").ClaudePermissionMode,
    task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
    logText: `Auto-started from queue on server "${server.name}" (${server.host}) — mode: ${server.claudePermissionMode}`,
  });

  if (outcome.ok) {
    clearDispatchBackoff(nextTask.id, backoff);
    return { dispatched: true, taskId: nextTask.id };
  }
  if (outcome.reason === "tmux_missing") return { dispatched: false, reason: "tmux_missing" };
  if (outcome.reason === "ssh_failed") {
    recordDispatchFailure(nextTask.id, backoff);
    return { dispatched: false, reason: "ssh_failed" };
  }
  return { dispatched: false, reason: "offline" };
}

async function _advanceAgentQueue(
  agentId: string,
  backoff: Map<string, BackoffEntry>,
): Promise<QueueAdvanceResult> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      name: true,
      tmuxSession: true,
      claudePermissionMode: true,
      claudeSessionPct: true,
      claudeWeekPct: true,
      server: {
        select: { host: true, port: true, username: true, sshKeyPath: true },
      },
    },
  });

  if (!agent) return { dispatched: false, reason: "offline" };
  if (!agent.tmuxSession || !agent.tmuxSession.trim()) {
    return { dispatched: false, reason: "offline" };
  }

  const sessionPct = agent.claudeSessionPct ?? 0;
  const weekPct = agent.claudeWeekPct ?? 0;

  if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
    return { dispatched: false, reason: "usage_blocked" };
  }

  const idleResult = await detectClaudeIdle(agent.server, agent.tmuxSession);

  if (idleResult.tmuxMissing) return { dispatched: false, reason: "tmux_missing" };
  if (!idleResult.isIdle) return { dispatched: false, reason: "not_idle" };

  const nextTask = await prisma.task.findFirst({
    where: { agentId, status: "queued" },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: { project: { select: { name: true } } },
  });

  if (!nextTask) return { dispatched: false, reason: "no_queued_tasks" };

  if (shouldSkipDueToBackoff(nextTask.id, backoff)) {
    return { dispatched: false, reason: "backoff" };
  }

  const outcome = await tryDispatchTaskToAgent({
    taskId: nextTask.id,
    agentId,
    sshConfig: agent.server,
    tmuxSession: agent.tmuxSession,
    task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
    logText: `Auto-started from queue on agent "${agent.name}" — mode: ${agent.claudePermissionMode}`,
  });

  if (outcome.ok) {
    clearDispatchBackoff(nextTask.id, backoff);
    return { dispatched: true, taskId: nextTask.id };
  }
  if (outcome.reason === "tmux_missing") return { dispatched: false, reason: "tmux_missing" };
  if (outcome.reason === "ssh_failed") {
    recordDispatchFailure(nextTask.id, backoff);
    return { dispatched: false, reason: "ssh_failed" };
  }
  return { dispatched: false, reason: "offline" };
}
