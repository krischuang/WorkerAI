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
import { emitAudit } from "@/lib/audit";
import { selectBestAgent, type AgentCandidate } from "@/lib/agent-selector";
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
      task: { title: task.title, description: task.description, projectName: task.project.name, isAutonomous: task.isAutonomous },
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
    tmuxSession: s.tmuxSession,
    permissionMode: s.claudePermissionMode as import("@/lib/ssh-claude-tmux").ClaudePermissionMode,
    task: { title: task.title, description: task.description, projectName: task.project.name, isAutonomous: task.isAutonomous },
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
  | { ok: true; verdict: "incomplete"; newStatus: "pending" | "completed" }
  | { ok: true; verdict: null } // timed out — no verdict from Claude
  | { ok: false; reason: "not_found" | "not_completed" | "no_server" | "server_busy" }
  | { ok: false; reason: "ssh_failed"; detail?: string };

const MAX_REVIEW_ATTEMPTS = 3;

const REVIEW_POLL_INTERVAL_MS = 10_000;
const REVIEW_POLL_TIMEOUT_MS  = 50_000;

async function pollForVerdict(
  ssh: ServerConfig,
  tmuxSession: string,
  timeoutMs: number,
): Promise<{ verdict: "done" | "incomplete" | null; notes: string | null }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, REVIEW_POLL_INTERVAL_MS));

    try {
      const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${tmuxSession} -p`, 5_000);
      const pane = cleanPane(stdout);
      const verdictMatch = pane.match(/VERDICT:\s*(done|incomplete)/i);
      if (verdictMatch) {
        // Extract up to 500 chars after the verdict line as notes
        const afterVerdict = pane.slice(pane.indexOf(verdictMatch[0]) + verdictMatch[0].length).trim();
        const notes = afterVerdict.slice(0, 500) || null;
        return {
          verdict: verdictMatch[1].toLowerCase() === "done" ? "done" : "incomplete",
          notes,
        };
      }
    } catch {
      // SSH hiccup — keep polling until the deadline
    }
  }

  return { verdict: null, notes: null };
}

/**
 * Send a review prompt to the Claude session for a completed task and wait for
 * the VERDICT response.  Holds the server dispatch lock throughout so no new
 * task can corrupt the session while Claude is replying.
 *
 * Supports both server-direct tasks (uses server.tmuxSession) and agent tasks
 * (uses agent.tmuxSession on the agent's parent server).
 *
 * Call sites: POST /api/tasks/[id]/review, processReviewQueue
 */
export async function reviewTask(taskId: string): Promise<ReviewResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      server: true,
      agent: { include: { server: true } },
      executionLogs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  if (!task) return { ok: false, reason: "not_found" };
  if (task.status !== "completed") return { ok: false, reason: "not_completed" };

  const latestLog = task.executionLogs[0] ?? null;

  const reviewPrompt = buildReviewPrompt({
    title: task.title,
    description: task.description,
    resultSummary: task.resultSummary,
    outputSummary: latestLog?.outputSummary,
    logText: latestLog?.logText,
  });

  // ── Resolve server config + tmux session (server or agent path) ──────────────
  let ssh: ServerConfig;
  let tmuxSession: string;
  let lockResourceId: string;
  let busyWhere: { serverId?: string; agentId?: string };

  if (task.agent) {
    const a = task.agent;
    const s = a.server;
    ssh = { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath };
    tmuxSession = a.tmuxSession;
    lockResourceId = a.id;
    busyWhere = { agentId: a.id };
  } else if (task.server) {
    const s = task.server;
    ssh = { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath };
    tmuxSession = s.tmuxSession;
    lockResourceId = s.id;
    busyWhere = { serverId: s.id };
  } else {
    return { ok: false, reason: "no_server" };
  }

  type LockOutcome =
    | { ok: true; verdict: "done" | "incomplete" | null; notes: string | null }
    | { ok: false; reason: "server_busy" | "ssh_failed"; detail?: string };

  const lockOutcome = await withServerDispatchLock<LockOutcome>(lockResourceId, async () => {
    const runningCount = await prisma.task.count({
      where: { ...busyWhere, status: "running" },
    });
    if (runningCount > 0) {
      return { ok: false, reason: "server_busy" } as const;
    }

    const sendResult = await sendRawPromptToTmux(ssh, reviewPrompt, tmuxSession);
    if (!sendResult.success) {
      return { ok: false, reason: "ssh_failed", detail: sendResult.error } as const;
    }

    const actorPayload = task.agent
      ? { agentId: task.agent.id }
      : { serverId: task.server!.id };
    await emitAudit({ entityType: "task", entityId: taskId, eventType: "task.review.sent", actorType: "system", payload: actorPayload });

    const { verdict, notes } = await pollForVerdict(ssh, tmuxSession, REVIEW_POLL_TIMEOUT_MS);
    return { ok: true, verdict, notes } as const;
  });

  if (!lockOutcome.ok) return lockOutcome;

  const { verdict, notes } = lockOutcome;
  const completedAt = new Date();

  if (verdict === "done") {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: "archived",
        reviewStatus: "done",
        reviewCompletedAt: completedAt,
        ...(notes && { reviewVerdictNotes: notes }),
      },
    });
    await emitAudit({ entityType: "task", entityId: taskId, eventType: "task.review.done", actorType: "system" });
    return { ok: true, verdict: "done", newStatus: "archived" };
  }
  if (verdict === "incomplete") {
    const newAttempts = task.reviewAttempts + 1;
    if (newAttempts >= MAX_REVIEW_ATTEMPTS) {
      // Cap reached — stop looping; leave task as completed but mark review failed.
      await prisma.task.update({
        where: { id: taskId },
        data: {
          reviewStatus: "failed",
          reviewAttempts: newAttempts,
          reviewCompletedAt: completedAt,
          ...(notes && { reviewVerdictNotes: notes }),
          // status intentionally not changed — task remains "completed"
          // retryCount intentionally not touched
        },
      });
      await emitAudit({
        entityType: "task",
        entityId: taskId,
        eventType: "task.review.max_attempts_reached",
        actorType: "system",
        payload: { attempts: newAttempts },
      });
      return { ok: true, verdict: "incomplete", newStatus: "completed" };
    }

    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: "pending",
        resultSummary: null,
        reviewStatus: "incomplete",
        reviewAttempts: newAttempts,
        reviewCompletedAt: completedAt,
        ...(notes && { reviewVerdictNotes: notes }),
        // retryCount intentionally not touched
      },
    });
    await emitAudit({ entityType: "task", entityId: taskId, eventType: "task.review.incomplete", actorType: "system", payload: { attempt: newAttempts } });
    return { ok: true, verdict: "incomplete", newStatus: "pending" };
  }

  // Timed out — leave reviewStatus as running; caller may retry or mark failed
  return { ok: true, verdict: null };
}

// ─── processReviewQueue ───────────────────────────────────────────────────────

/**
 * Find tasks whose auto-review grace delay has elapsed and run up to maxBatch
 * reviews per call.  Called each poller cycle.
 *
 * Guard: skips tasks whose assigned resource (server or agent) has running tasks,
 * matching the same guard used in the manual review route.
 */
export async function processReviewQueue(maxBatch = 3): Promise<void> {
  const due = await prisma.task.findMany({
    where: {
      reviewStatus: "pending",
      reviewScheduledAt: { lte: new Date() },
    },
    orderBy: { reviewScheduledAt: "asc" },
    take: maxBatch,
    select: { id: true },
  });

  for (const { id } of due) {
    // Mark running so parallel cycles don't double-process
    await prisma.task.update({
      where: { id },
      data: { reviewStatus: "running", reviewStartedAt: new Date() },
    });

    try {
      const result = await reviewTask(id);
      if (!result.ok) {
        if (result.reason === "server_busy") {
          // Reschedule 5 minutes from now when the resource is free
          await prisma.task.update({
            where: { id },
            data: { reviewStatus: "pending", reviewScheduledAt: new Date(Date.now() + 5 * 60_000) },
          });
        } else {
          // Permanent failure — clear review state so it won't loop
          await prisma.task.update({
            where: { id },
            data: { reviewStatus: "skipped", reviewCompletedAt: new Date() },
          });
        }
      } else if (result.verdict === null) {
        // Timed out — reschedule
        await prisma.task.update({
          where: { id },
          data: { reviewStatus: "pending", reviewScheduledAt: new Date(Date.now() + 5 * 60_000) },
        });
      }
      // verdict "done" / "incomplete" states already written by reviewTask()
    } catch (err) {
      // Unexpected error — mark skipped to avoid infinite retry
      await prisma.task.update({
        where: { id },
        data: { reviewStatus: "skipped", reviewCompletedAt: new Date() },
      }).catch(() => {});
      throw err;
    }
  }
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
      tmuxSession: true,
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
    where: {
      serverId,
      status: "queued",
      agentId: null,
      OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
    },
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
    tmuxSession: server.tmuxSession,
    permissionMode: server.claudePermissionMode as import("@/lib/ssh-claude-tmux").ClaudePermissionMode,
    task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name, isAutonomous: nextTask.isAutonomous },
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
    where: {
      agentId,
      status: "queued",
      OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
    },
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
    task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name, isAutonomous: nextTask.isAutonomous },
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

// ─── autoAssignQueuedTasks ────────────────────────────────────────────────────

export interface AutoAssignSummary {
  assigned: number;
  skipped: number;
}

/**
 * Finds fully-unassigned pending tasks (no agentId, no serverId) belonging to projects with
 * autonomousMode >= 3 ("auto-create and auto-dispatch low/medium-risk tasks"), scores every
 * agent via lib/agent-selector.ts, and assigns + dispatches the best one.
 *
 * High-risk tasks are skipped entirely unless the project is at autonomousMode >= 4 AND has
 * explicitly set allowHighRiskAutonomy — see Project.allowHighRiskAutonomy and
 * Task.riskLevel (lib/risk-classifier.ts).
 *
 * Every decision — successful assignment or "no eligible agent" — emits an AuditEvent so the
 * reasoning is inspectable later. Call site: instrumentation.node.ts, every poller cycle.
 */
export async function autoAssignQueuedTasks(maxBatch = 20): Promise<AutoAssignSummary> {
  const candidates = await prisma.task.findMany({
    where: {
      status: "pending",
      agentId: null,
      serverId: null,
      blockedByCount: 0,
      project: { status: "active", autonomousMode: { gte: 3 } },
    },
    include: {
      project: { select: { id: true, name: true, autonomousMode: true, allowHighRiskAutonomy: true } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: maxBatch,
  });

  if (candidates.length === 0) return { assigned: 0, skipped: 0 };

  const [agentRows, taskCountRows] = await Promise.all([
    prisma.agent.findMany({
      select: {
        id: true, name: true, tags: true, status: true, healthScore: true,
        activeTaskCount: true, maxConcurrentTasks: true,
        claudeSessionPct: true, claudeWeekPct: true, pausedDueToUsage: true, cooldownUntil: true,
      },
    }),
    // Real-time workload: count tasks per agent broken down by status so the selector
    // uses accurate queue depth instead of the potentially-stale activeTaskCount field.
    prisma.task.groupBy({
      by: ["agentId", "status"],
      where: { agentId: { not: null }, status: { in: ["running", "queued"] } },
      _count: { id: true },
    }),
  ]);

  // Build per-agent workload maps from the grouped results.
  const runningByAgent = new Map<string, number>();
  const queuedByAgent = new Map<string, number>();
  for (const row of taskCountRows) {
    if (!row.agentId) continue;
    if (row.status === "running") runningByAgent.set(row.agentId, row._count.id);
    if (row.status === "queued")  queuedByAgent.set(row.agentId, row._count.id);
  }

  const now = new Date();
  let assigned = 0;
  let skipped = 0;

  for (const task of candidates) {
    const { project } = task;

    if (task.riskLevel === "high" && !(project.autonomousMode >= 4 && project.allowHighRiskAutonomy)) {
      skipped++;
      await emitAudit({
        entityType: "task",
        entityId: task.id,
        eventType: "agent.rejected",
        actorType: "system",
        payload: {
          reason: "high_risk_requires_explicit_opt_in",
          autonomousMode: project.autonomousMode,
          allowHighRiskAutonomy: project.allowHighRiskAutonomy,
        },
      });
      continue;
    }

    const candidateAgents: AgentCandidate[] = agentRows.map((a) => ({
      id: a.id,
      name: a.name,
      tags: a.tags,
      status: a.status,
      healthScore: a.healthScore,
      activeTaskCount: a.activeTaskCount,
      maxConcurrentTasks: a.maxConcurrentTasks,
      claudeSessionPct: a.claudeSessionPct,
      claudeWeekPct: a.claudeWeekPct,
      pausedDueToUsage: a.pausedDueToUsage,
      cooldownUntil: a.cooldownUntil,
      runningTaskCount: runningByAgent.get(a.id) ?? 0,
      queuedTaskCount: queuedByAgent.get(a.id) ?? 0,
    }));

    const { agentId, scores } = selectBestAgent(candidateAgents, { requiredTags: task.requiredTags }, now);

    if (!agentId) {
      skipped++;
      await emitAudit({
        entityType: "task",
        entityId: task.id,
        eventType: "agent.rejected",
        actorType: "system",
        payload: { reason: "no_eligible_agent", candidates: scores.map((s) => ({ agentId: s.agentId, agentName: s.agentName, reasons: s.reasons })) },
      });
      continue;
    }

    const selected = scores.find((s) => s.agentId === agentId)!;

    await prisma.task.update({ where: { id: task.id }, data: { agentId, status: "queued" } });

    await emitAudit({
      entityType: "task",
      entityId: task.id,
      eventType: "agent.selected",
      actorType: "system",
      payload: { agentId, agentName: selected.agentName, score: selected.score, reasons: selected.reasons, projectId: project.id },
    });

    // Record the other eligible-but-not-chosen candidates too, capped to keep the payload small.
    const rejectedOthers = scores.filter((s) => s.agentId !== agentId).slice(0, 5);
    for (const r of rejectedOthers) {
      await emitAudit({
        entityType: "task",
        entityId: task.id,
        eventType: "agent.rejected",
        actorType: "system",
        payload: { agentId: r.agentId, agentName: r.agentName, eligible: r.eligible, reasons: r.reasons },
      });
    }

    // Keep in-memory workload maps consistent so a second task in the same batch
    // sees the updated queue depth and doesn't over-assign to the same agent.
    queuedByAgent.set(agentId, (queuedByAgent.get(agentId) ?? 0) + 1);

    assigned++;

    // Attempt immediate dispatch. If it fails (usage gate, transient SSH issue), the task stays
    // "queued" with an agent assigned — a later manual Run or queue-advance cycle can pick it up.
    await dispatchTask(task.id).catch((err) => {
      console.error(`[autoAssignQueuedTasks] dispatch of task ${task.id} threw:`, err);
    });
  }

  return { assigned, skipped };
}
