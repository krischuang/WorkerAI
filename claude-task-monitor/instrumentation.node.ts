/**
 * Node.js-only instrumentation — imported by instrumentation.ts when
 * NEXT_RUNTIME === "nodejs". Module-level code runs on import, which is
 * how Next.js triggers it (no register() call needed).
 *
 * Background poller fires every 60 seconds:
 *   1.   Fetches Claude CLI usage for every server via its tmux session.
 *   1b.  Fetches Claude CLI usage for every agent via its own tmux session.
 *   2.   Checks running server-direct tasks for Claude idle state; marks completed.
 *   2b.  Checks running agent tasks for Claude idle state; marks completed.
 *   3.   Auto-advances the queue: dispatches the next queued server-direct task.
 *   4.   Auto-advances the queue: dispatches the next queued agent task.
 *
 * A globalThis._pollerRunning flag (set before runCheck, cleared in finally)
 * ensures overlapping poll cycles cannot happen even if a cycle takes longer
 * than the 60 s interval.
 */

import { prisma } from "./lib/prisma";
import {
  fetchClaudeUsageViaTmux,
  detectClaudeIdle,
  detectTaskCompletion,
  killTaskTmuxSession,
  launchClaudeInTmux,
  type ClaudePermissionMode,
} from "./lib/ssh-claude-tmux";
import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "./lib/task-dispatch";
import { USAGE_THRESHOLD, IDLE_FALLBACK_MIN_MS, POST_RESET_RESTART_BUFFER_MS } from "./lib/constants";
import { resolveTaskTimeout } from "./lib/task-timeout";
import { runHealthChecks } from "./lib/worker-health";
import { runAutoRecovery } from "./lib/auto-recovery";
import { detectZombieTasks } from "./lib/zombie-detection";
import { evaluateRetry } from "./lib/task-retry";
import {
  shouldSkipDueToBackoff,
  recordDispatchFailure,
  clearDispatchBackoff,
  shouldSkipAgentOffline,
  recordAgentOffline,
  clearAgentOffline,
  type BackoffEntry,
} from "./lib/dispatch-backoff";
import { upsertScheduledResume, triggerDueResumes, nearestResetsAt } from "./lib/scheduled-resume";
import { emitAudit } from "./lib/audit";
import { recalculateProjectProgress, reconcileAllProjects } from "./lib/project-progress";
import {
  archiveOldLogs,
  shouldRunNightlyArchival,
  completedHowToExitReason,
  lastNLines,
} from "./lib/execution-log-archival";
import { updateAllServerCapacity } from "./lib/server-capacity";
import { generateDailyReport, todaysReportExists } from "./lib/daily-report-service";
import { generateWeeklyAnalytics, priorWeekStart, weeklyAnalyticsExists } from "./lib/weekly-analytics-service";
import { unblockDependents } from "./lib/task-dependency";
import { processReviewQueue } from "./lib/task-service";
import { runDueProjectScans } from "./lib/project-scan-service";
import { advanceImprovementCycles, startDueImprovementCycles } from "./lib/improvement-cycle-service";

const TAG = "[usage-poller]";

// Preserve state across Next.js HMR module re-evaluations.
const g = globalThis as unknown as {
  _usagePollerStarted?: boolean;
  _pollerRunning?: boolean;
  _dispatchBackoff?: Map<string, BackoffEntry>;
  _agentOfflineStore?: Map<string, number>;
  _pollerCycleCount?: number;
  _lastArchivalDate?: string | null;
  _lastDailyReportDate?: string | null;
  _lastWeeklyAnalyticsDate?: string | null;
  _lastProjectScanDate?: string | null;
  // zombie-detection pane-line baseline (owned by lib/zombie-detection.ts)
  _zombiePaneLines?: Map<string, number>;
  // Server/agent IDs whose Claude CLI session must be restarted before the next
  // /usage check (populated when a scheduled resume fires after a usage reset).
  _pendingServerRestarts?: Set<string>;
  _pendingAgentRestarts?: Set<string>;
};

if (!g._usagePollerStarted) {
  g._usagePollerStarted = true;
  if (!g._dispatchBackoff) g._dispatchBackoff = new Map();
  if (!g._agentOfflineStore) g._agentOfflineStore = new Map();
  if (g._pollerCycleCount === undefined) g._pollerCycleCount = 0;
  if (g._lastArchivalDate === undefined) g._lastArchivalDate = null;
  if (g._lastDailyReportDate === undefined) g._lastDailyReportDate = null;
  if (g._lastWeeklyAnalyticsDate === undefined) g._lastWeeklyAnalyticsDate = null;
  if (g._lastProjectScanDate === undefined) g._lastProjectScanDate = null;
  if (!g._pendingServerRestarts) g._pendingServerRestarts = new Set();
  if (!g._pendingAgentRestarts) g._pendingAgentRestarts = new Set();
  startPoller();
}

async function runProjectScansIfNeeded() {
  const now = new Date();
  // Run once per day at or after 2 AM UTC (staggered from analytics/reports)
  if (now.getUTCHours() < 2) return;
  const todayKey = now.toISOString().slice(0, 10);
  if (g._lastProjectScanDate === todayKey) return;
  g._lastProjectScanDate = todayKey;
  try {
    await runDueProjectScans();
  } catch (err) {
    console.error(`${TAG} runDueProjectScans threw:`, err);
  }
}

async function runWeeklyAnalyticsIfNeeded() {
  const now = new Date();
  // Only run on Mondays at or after 1 AM UTC
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 1) return;
  const weekKey = now.toISOString().slice(0, 10);
  if (g._lastWeeklyAnalyticsDate === weekKey) return;
  try {
    const weekStart = priorWeekStart(now);
    const exists = await weeklyAnalyticsExists(weekStart);
    if (!exists) {
      await generateWeeklyAnalytics(weekStart);
      console.log(`${TAG} Weekly analytics generated for week starting ${weekStart.toISOString().slice(0, 10)}`);
    }
    g._lastWeeklyAnalyticsDate = weekKey;
  } catch (err) {
    console.error(`${TAG} Weekly analytics threw:`, err);
  }
}

async function runDailyReportIfNeeded() {
  const now = new Date();
  if (now.getUTCHours() < 1) return;
  const todayUTC = now.toISOString().slice(0, 10);
  if (g._lastDailyReportDate === todayUTC) return;
  try {
    const exists = await todaysReportExists();
    if (!exists) {
      await generateDailyReport("auto");
      console.log(`${TAG} Auto daily report generated for ${todayUTC}`);
    }
    g._lastDailyReportDate = todayUTC;
  } catch (err) {
    console.error(`${TAG} Auto daily report threw:`, err);
  }
}

function startPoller() {
  // ── Core polling logic ──────────────────────────────────────────────────────

  async function runCheck() {
    const ts = new Date().toISOString();
    console.log(`${TAG} ${ts} — poll start`);

    const backoff = g._dispatchBackoff!;
    const agentOfflineStore = g._agentOfflineStore!;
    const pendingServerRestarts = g._pendingServerRestarts!;
    const pendingAgentRestarts = g._pendingAgentRestarts!;

    // ── 0. Compute and persist capacity scores for all servers ────────────────
    try {
      await updateAllServerCapacity();
    } catch (err) {
      console.error(`${TAG} updateAllServerCapacity threw:`, err);
    }

    // ── 0b. Fire any scheduled resumes whose time has arrived ─────────────────
    // triggerDueResumes returns resources that need a Claude CLI restart before
    // the next /usage check — the stale-cache problem means we must restart the
    // process or /usage will continue reporting the pre-reset percentage.
    try {
      const triggered = await triggerDueResumes();
      for (const { resourceType, resourceId } of triggered) {
        if (resourceType === "server") pendingServerRestarts.add(resourceId);
        else if (resourceType === "agent") pendingAgentRestarts.add(resourceId);
      }
    } catch (err) {
      console.error(`${TAG} triggerDueResumes threw:`, err);
    }

    // Servers confirmed offline (tmux session missing) in this cycle.
    const offlineServerIds = new Set<string>();
    // Agents confirmed offline (tmux session missing) in this cycle.
    const offlineAgentIds = new Set<string>();

    // ── 1. Refresh Claude usage for every server ────────────────────────────
    let servers: {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      sshKeyPath: string;
      tmuxSession: string;
      claudePermissionMode: string | null;
      pausedDueToUsage: boolean;
      autoPauseEnabled: boolean;
    }[] = [];

    try {
      servers = await prisma.server.findMany({
        select: {
          id: true,
          name: true,
          host: true,
          port: true,
          username: true,
          sshKeyPath: true,
          tmuxSession: true,
          claudePermissionMode: true,
          pausedDueToUsage: true,
          autoPauseEnabled: true,
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load servers:`, err);
    }

    await Promise.allSettled(
      servers.map(async (srv) => {
        const sshCfg = { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath };
        const needsRestart = pendingServerRestarts.has(srv.id);

        // ── Restart Claude CLI session if required by a scheduled resume ──────
        // The Claude CLI caches the usage state for the lifetime of the process.
        // Running /usage in the same session after 100% may return stale data even
        // after the quota has reset.  We kill and relaunch before fetching.
        if (needsRestart) {
          pendingServerRestarts.delete(srv.id);
          console.log(`${TAG} ${srv.name}: restarting Claude session after usage reset`);
          const permMode = (srv.claudePermissionMode as ClaudePermissionMode) ?? "workspace_write";
          const restartResult = await launchClaudeInTmux(sshCfg, permMode, srv.tmuxSession);
          if (!restartResult.success) {
            console.warn(`${TAG} ${srv.name}: session restart failed — ${restartResult.error}`);
          } else {
            console.log(`${TAG} ${srv.name}: session restarted, waiting for Claude startup`);
            await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          }
        }

        const result = await fetchClaudeUsageViaTmux(sshCfg, srv.tmuxSession);

        if (result.success) {
          const freshSession = result.parsed.sessionPct ?? 0;
          const freshWeek = result.parsed.weekPct ?? 0;
          const isUnblocked = freshSession < USAGE_THRESHOLD && freshWeek < USAGE_THRESHOLD;

          await prisma.server.update({
            where: { id: srv.id },
            data: {
              status:                "connected",
              claudeSessionPct:      result.parsed.sessionPct      ?? null,
              claudeSessionResets:   result.parsed.sessionResets    ?? null,
              claudeSessionResetsAt: result.parsed.sessionResetsAt  ?? null,
              claudeWeekPct:         result.parsed.weekPct           ?? null,
              claudeWeekResets:      result.parsed.weekResets        ?? null,
              claudeWeekResetsAt:    result.parsed.weekResetsAt      ?? null,
              claudeUsageRaw:        result.rawOutput.slice(0, 500),
              claudeUsageFetchedAt:  new Date(),
              // If usage recovered after a restart, clear the pause immediately so
              // the worker can accept tasks even if no tasks are currently queued.
              ...(srv.pausedDueToUsage && isUnblocked ? { pausedDueToUsage: false, pausedAt: null } : {}),
            },
          });

          if (needsRestart) {
            if (isUnblocked) {
              console.log(
                `${TAG} ${srv.name}: fresh usage fetched (session=${freshSession}% week=${freshWeek}%) — worker resumed`
              );
            } else {
              // Still at limit after a full restart — schedule next attempt at the next reset.
              console.log(
                `${TAG} ${srv.name}: still rate-limited after restart ` +
                `(session=${freshSession}% week=${freshWeek}%) — worker paused until next reset`
              );
              if (srv.autoPauseEnabled) {
                const nextResetsAt = nearestResetsAt(
                  result.parsed.sessionResetsAt,
                  result.parsed.weekResetsAt,
                );
                if (nextResetsAt) {
                  const scheduleAt = new Date(nextResetsAt.getTime() + POST_RESET_RESTART_BUFFER_MS);
                  await upsertScheduledResume("server", srv.id, scheduleAt);
                  console.log(
                    `${TAG} ${srv.name}: rescheduled restart for ${scheduleAt.toISOString()}`
                  );
                }
              }
            }
          } else {
            console.log(
              `${TAG} ${srv.name}: session=${freshSession}% week=${freshWeek}%`
            );
            if (srv.pausedDueToUsage && isUnblocked) {
              console.log(`${TAG} ${srv.name}: usage recovered — worker resumed`);
            }
          }
        } else {
          const isTmuxMissing = result.status === "offline" &&
            (result.error ?? "").includes("not found");

          if (isTmuxMissing) {
            offlineServerIds.add(srv.id);
            try {
              await prisma.server.update({
                where: { id: srv.id },
                data: { status: "failed", claudeUsageFetchedAt: new Date() },
              });
            } catch (dbErr) {
              console.error(`${TAG} ${srv.name}: failed to mark server offline:`, dbErr);
            }
            console.log(
              `${TAG} ${srv.name}: tmux session '${srv.tmuxSession}' not found — marked offline, queue advance skipped`
            );
          } else {
            console.warn(
              `${TAG} ${srv.name}: usage unavailable — ${result.status}` +
                (result.error ? `: ${result.error}` : "")
            );
          }
        }
      })
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected")
          console.error(`${TAG} ${servers[i].name}: usage fetch threw:`, r.reason);
      });
    });

    // ── 1b. Refresh Claude usage for every agent via its own tmux session ────
    let agents: {
      id: string;
      name: string;
      tmuxSession: string;
      claudePermissionMode: string;
      workDir: string | null;
      pausedDueToUsage: boolean;
      autoPauseEnabled: boolean;
      server: {
        host: string;
        port: number;
        username: string;
        sshKeyPath: string;
      };
    }[] = [];

    try {
      agents = await prisma.agent.findMany({
        select: {
          id: true,
          name: true,
          tmuxSession: true,
          claudePermissionMode: true,
          workDir: true,
          pausedDueToUsage: true,
          autoPauseEnabled: true,
          server: {
            select: { host: true, port: true, username: true, sshKeyPath: true },
          },
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load agents:`, err);
    }

    await Promise.allSettled(
      agents.map(async (agent) => {
        // Guard: missing tmuxSession — mark offline immediately without SSH.
        if (!agent.tmuxSession || !agent.tmuxSession.trim()) {
          console.warn(
            `${TAG} Agent ${agent.name}: tmuxSession is not configured — ` +
            `marking offline, skipping dispatch`
          );
          offlineAgentIds.add(agent.id);
          recordAgentOffline(agent.id, agentOfflineStore);
          try {
            await prisma.agent.update({
              where: { id: agent.id },
              data: { status: "offline", claudeUsageFetchedAt: new Date() },
            });
          } catch (dbErr) {
            console.error(`${TAG} Agent ${agent.name}: failed to mark offline:`, dbErr);
          }
          return;
        }

        // Skip SSH if within offline backoff window — prevents re-pinging every 60 s.
        if (shouldSkipAgentOffline(agent.id, agentOfflineStore)) {
          offlineAgentIds.add(agent.id);
          return;
        }

        const needsRestart = pendingAgentRestarts.has(agent.id);

        // ── Restart Claude CLI session if required by a scheduled resume ──────
        if (needsRestart) {
          pendingAgentRestarts.delete(agent.id);
          console.log(`${TAG} Agent ${agent.name}: restarting Claude session after usage reset`);
          const permMode = (agent.claudePermissionMode as ClaudePermissionMode) ?? "workspace_write";
          const restartResult = await launchClaudeInTmux(
            agent.server,
            permMode,
            agent.tmuxSession,
            agent.workDir ?? undefined,
          );
          if (!restartResult.success) {
            console.warn(`${TAG} Agent ${agent.name}: session restart failed — ${restartResult.error}`);
          } else {
            console.log(`${TAG} Agent ${agent.name}: session restarted, waiting for Claude startup`);
            await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          }
        }

        const result = await fetchClaudeUsageViaTmux(agent.server, agent.tmuxSession);

        if (result.success) {
          clearAgentOffline(agent.id, agentOfflineStore);
          const freshSession = result.parsed.sessionPct ?? 0;
          const freshWeek = result.parsed.weekPct ?? 0;
          const isUnblocked = freshSession < USAGE_THRESHOLD && freshWeek < USAGE_THRESHOLD;

          await prisma.agent.update({
            where: { id: agent.id },
            data: {
              status:                "idle",
              claudeSessionPct:      result.parsed.sessionPct      ?? null,
              claudeSessionResets:   result.parsed.sessionResets    ?? null,
              claudeSessionResetsAt: result.parsed.sessionResetsAt  ?? null,
              claudeWeekPct:         result.parsed.weekPct           ?? null,
              claudeWeekResets:      result.parsed.weekResets        ?? null,
              claudeWeekResetsAt:    result.parsed.weekResetsAt      ?? null,
              claudeUsageRaw:        result.rawOutput.slice(0, 500),
              claudeUsageFetchedAt:  new Date(),
              ...(agent.pausedDueToUsage && isUnblocked ? { pausedDueToUsage: false, pausedAt: null } : {}),
            },
          });

          if (needsRestart) {
            if (isUnblocked) {
              console.log(
                `${TAG} Agent ${agent.name}: fresh usage fetched (session=${freshSession}% week=${freshWeek}%) — worker resumed`
              );
            } else {
              console.log(
                `${TAG} Agent ${agent.name}: still rate-limited after restart ` +
                `(session=${freshSession}% week=${freshWeek}%) — worker paused until next reset`
              );
              if (agent.autoPauseEnabled) {
                const nextResetsAt = nearestResetsAt(
                  result.parsed.sessionResetsAt,
                  result.parsed.weekResetsAt,
                );
                if (nextResetsAt) {
                  const scheduleAt = new Date(nextResetsAt.getTime() + POST_RESET_RESTART_BUFFER_MS);
                  await upsertScheduledResume("agent", agent.id, scheduleAt);
                  console.log(
                    `${TAG} Agent ${agent.name}: rescheduled restart for ${scheduleAt.toISOString()}`
                  );
                }
              }
            }
          } else {
            console.log(
              `${TAG} Agent ${agent.name}: session=${freshSession}% week=${freshWeek}%`
            );
            if (agent.pausedDueToUsage && isUnblocked) {
              console.log(`${TAG} Agent ${agent.name}: usage recovered — worker resumed`);
            }
          }
        } else {
          const isTmuxMissing = result.status === "offline" &&
            (result.error ?? "").includes("not found");

          if (isTmuxMissing) {
            offlineAgentIds.add(agent.id);
            recordAgentOffline(agent.id, agentOfflineStore);
            try {
              await prisma.agent.update({
                where: { id: agent.id },
                data: { status: "offline", claudeUsageFetchedAt: new Date() },
              });
            } catch (dbErr) {
              console.error(`${TAG} Agent ${agent.name}: failed to mark offline:`, dbErr);
            }
            console.log(
              `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' not found — ` +
              `marked offline, queue advance skipped`
            );
            emitAudit({ entityType: "agent", entityId: agent.id, eventType: "agent.offline", actorType: "poller", payload: { reason: "tmux_missing", tmuxSession: agent.tmuxSession } }).catch(() => {});
          } else {
            console.warn(
              `${TAG} Agent ${agent.name}: usage unavailable — ${result.status}` +
                (result.error ? `: ${result.error}` : "")
            );
          }
        }
      })
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected")
          console.error(`${TAG} Agent ${agents[i].name}: usage fetch threw:`, r.reason);
      });
    });

    // ── 2. Detect completion (server-direct tasks) ────────────────────────────
    // Each server-direct task now has its own tmux session (claude_<taskId>),
    // so tasks are checked individually rather than grouped per server.
    // Tasks without a taskTmuxSession (legacy) fall back to server.tmuxSession.
    let runningTasks: {
      id: string;
      projectId: string;
      serverId: string | null;
      completionNonce: string | null;
      tmuxOutputOffset: number | null;
      taskTmuxSession: string | null;
      timeoutMinutes: number | null;
      updatedAt: Date;
      executionLogs: { id: string; startedAt: Date; status: string; finishedAt: Date | null }[];
      server: {
        id: string;
        name: string;
        host: string;
        port: number;
        username: string;
        sshKeyPath: string;
        tmuxSession: string;
        claudePermissionMode: string | null;
        claudeSessionPct: number | null;
        claudeWeekPct: number | null;
        defaultTaskTimeoutMinutes: number | null;
      } | null;
    }[] = [];

    try {
      runningTasks = await prisma.task.findMany({
        where: { status: "running", agentId: null },
        select: {
          id: true,
          projectId: true,
          serverId: true,
          completionNonce: true,
          tmuxOutputOffset: true,
          taskTmuxSession: true,
          timeoutMinutes: true,
          updatedAt: true,
          executionLogs: {
            where: { status: "running", finishedAt: null },
            orderBy: { startedAt: "desc" },
            take: 1,
            select: { id: true, startedAt: true, status: true, finishedAt: true },
          },
          server: {
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
              defaultTaskTimeoutMinutes: true,
            },
          },
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load running tasks:`, err);
    }

    // Collect serverId → server info for queue-advance after completions.
    const byServer = new Map<string, (typeof runningTasks)[number]["server"] & { id: string }>();
    for (const task of runningTasks) {
      if (task.serverId && task.server && !byServer.has(task.serverId)) {
        byServer.set(task.serverId, task.server as NonNullable<typeof task.server>);
      }
    }

    await Promise.allSettled(
      runningTasks.map(async (task) => {
        if (!task.serverId || !task.server) return;
        const srv = task.server;
        const serverId = task.serverId;

        if (offlineServerIds.has(serverId)) {
          console.log(`${TAG} ${srv.name}: skipping completion check for task "${task.id}" — server offline`);
          return;
        }

        // ── Timeout enforcement ──────────────────────────────────────────────
        const latestRunLog = task.executionLogs[0] ?? null;
        if (latestRunLog) {
          const timeoutMin = resolveTaskTimeout(
            task.timeoutMinutes,
            srv.defaultTaskTimeoutMinutes,
            null,
          );
          const deadlineMs = latestRunLog.startedAt.getTime() + timeoutMin * 60_000;
          if (Date.now() > deadlineMs) {
            const msg = `Execution timeout (${timeoutMin}min)`;
            const timeoutAt = new Date();
            console.log(`${TAG} ${srv.name}: task "${task.id}" exceeded ${timeoutMin}min timeout — failing`);
            try {
              await prisma.$transaction(async (tx) => {
                await tx.task.update({ where: { id: task.id }, data: { status: "failed" } });
                await tx.executionLog.update({
                  where: { id: latestRunLog.id },
                  data: {
                    status: "failed",
                    finishedAt: timeoutAt,
                    errorMessage: msg,
                    exitReason: "timeout",
                    durationMs: timeoutAt.getTime() - latestRunLog.startedAt.getTime(),
                  },
                });
              });
            } catch (err) {
              console.error(`${TAG} Task ${task.id}: failed to record timeout:`, err);
            }
            if (task.taskTmuxSession) {
              const sshCfg = { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath };
              await killTaskTmuxSession(sshCfg, task.id).catch(() => {});
            }
            clearDispatchBackoff(task.id, backoff);
            console.log(`[TASK_TIMEOUT] taskId="${task.id}" timeoutMin=${timeoutMin}`);
            emitAudit({ entityType: "task", entityId: task.id, eventType: "task.timeout", actorType: "poller", payload: { timeoutMin, serverId } }).catch(() => {});
            recalculateProjectProgress(task.projectId).catch(() => {});
            await evaluateRetry(task.id, "timeout").catch((err) => {
              console.error(`${TAG} Task ${task.id}: retry evaluation failed:`, err);
            });
            return;
          }
        }

        // Use the task's own session; fall back to server session for legacy tasks.
        const checkSession = task.taskTmuxSession ?? srv.tmuxSession;
        const sshConfig = { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath };

        const completionResult = await detectTaskCompletion(
          sshConfig,
          checkSession,
          task.id,
          task.completionNonce ?? undefined,
          task.tmuxOutputOffset ?? undefined,
        );

        if (completionResult.tmuxMissing) {
          if (task.taskTmuxSession) {
            // The per-task session is gone — treat as completed (session may have
            // been killed externally) rather than marking the whole server offline.
            console.log(
              `${TAG} ${srv.name}: per-task session '${task.taskTmuxSession}' not found — marking task completed`
            );
          } else {
            // Legacy path: missing server session means server is offline.
            offlineServerIds.add(serverId);
            try {
              await prisma.server.update({ where: { id: serverId }, data: { status: "failed" } });
            } catch { /* non-fatal */ }
            console.log(
              `${TAG} ${srv.name}: shared tmux session '${srv.tmuxSession}' not found — marking server offline`
            );
            return;
          }
        }

        // Determine how (or whether) the task completed.
        let completedHow: string | null = null;
        if (completionResult.markerFound) {
          completedHow = "completion marker";
        } else if (completionResult.tmuxMissing && task.taskTmuxSession) {
          completedHow = "session gone";
        } else if (completionResult.isIdle && !task.completionNonce) {
          completedHow = "idle prompt (no nonce)";
        } else if (completionResult.isIdle) {
          const runMs = Date.now() - task.updatedAt.getTime();
          if (runMs >= IDLE_FALLBACK_MIN_MS) {
            completedHow = `idle fallback (no marker after ${Math.round(runMs / 60_000)}m)`;
            console.log(
              `${TAG} ${srv.name}: task "${task.id}" idle without nonce marker — ` +
              `using idle fallback after ${Math.round(runMs / 60_000)}m`
            );
          }
        }
        if (!completedHow) return;

        try {
          const finishedAt = new Date();
          const paneCapture = completionResult.paneText
            ? lastNLines(completionResult.paneText, 200)
            : null;
          const exitReason = completedHowToExitReason(completedHow);

          await prisma.$transaction(async (tx) => {
            const latestLog = await tx.executionLog.findFirst({
              where: { taskId: task.id, status: "running", finishedAt: null },
              orderBy: { createdAt: "desc" },
              select: { id: true, startedAt: true },
            });
            await tx.task.update({ where: { id: task.id }, data: { status: "completed" } });
            if (latestLog) {
              const durationMs = finishedAt.getTime() - latestLog.startedAt.getTime();
              await tx.executionLog.update({
                where: { id: latestLog.id },
                data: {
                  status: "completed",
                  finishedAt,
                  durationMs,
                  exitReason,
                  paneCapture,
                },
              });
            }
          });

          clearDispatchBackoff(task.id, backoff);
          console.log(`[TASK_FINISHED] taskId="${task.id}" detectedBy="${completedHow}"`);
          emitAudit({ entityType: "task", entityId: task.id, eventType: "task.completed", actorType: "poller", payload: { detectedBy: completedHow, serverId } }).catch(() => {});
          recalculateProjectProgress(task.projectId).catch(() => {});
          unblockDependents(task.id).catch(() => {});

          // Schedule auto-review if project has autoReviewEnabled
          prisma.project.findUnique({ where: { id: task.projectId }, select: { autoReviewEnabled: true } })
            .then((proj) => {
              if (!proj?.autoReviewEnabled) return;
              return prisma.task.update({
                where: { id: task.id },
                data: {
                  autoReviewEnabled: true,
                  reviewStatus: "pending",
                  reviewScheduledAt: new Date(Date.now() + 5 * 60_000),
                },
              });
            })
            .catch(() => {});

          // Clean up the per-task tmux session now that the task is done.
          if (task.taskTmuxSession) {
            await killTaskTmuxSession(sshConfig, task.id);
          }
        } catch (err) {
          console.error(`${TAG} Task ${task.id}: failed to mark completed:`, err);
        }
      })
    ).then((results) => {
      runningTasks.forEach((t, i) => {
        if (results[i].status === "rejected")
          console.error(`${TAG} Completion check for task "${t.id}" threw:`, (results[i] as PromiseRejectedResult).reason);
      });
    });

    // ── 2b. Detect completion + auto-advance queue (agent tasks) ─────────────
    let runningAgentTasks: {
      id: string;
      projectId: string;
      agentId: string | null;
      completionNonce: string | null;
      tmuxOutputOffset: number | null;
      timeoutMinutes: number | null;
      updatedAt: Date;
      executionLogs: { id: string; startedAt: Date; status: string; finishedAt: Date | null }[];
      agent: {
        id: string;
        name: string;
        tmuxSession: string;
        claudePermissionMode: string;
        claudeSessionPct: number | null;
        claudeWeekPct: number | null;
        defaultTaskTimeoutMinutes: number | null;
        server: {
          host: string;
          port: number;
          username: string;
          sshKeyPath: string;
        };
      } | null;
    }[] = [];

    try {
      runningAgentTasks = await prisma.task.findMany({
        where: { status: "running", agentId: { not: null } },
        select: {
          id: true,
          projectId: true,
          agentId: true,
          completionNonce: true,
          tmuxOutputOffset: true,
          timeoutMinutes: true,
          updatedAt: true,
          executionLogs: {
            where: { status: "running", finishedAt: null },
            orderBy: { startedAt: "desc" },
            take: 1,
            select: { id: true, startedAt: true, status: true, finishedAt: true },
          },
          agent: {
            select: {
              id: true,
              name: true,
              tmuxSession: true,
              claudePermissionMode: true,
              claudeSessionPct: true,
              claudeWeekPct: true,
              defaultTaskTimeoutMinutes: true,
              server: {
                select: { host: true, port: true, username: true, sshKeyPath: true },
              },
            },
          },
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load running agent tasks:`, err);
    }

    // Map taskId → projectId for progress recalculation after status changes
    const agentTaskProjectId = new Map<string, string>();
    for (const t of runningAgentTasks) agentTaskProjectId.set(t.id, t.projectId);

    type AgentInfo = NonNullable<(typeof runningAgentTasks)[number]["agent"]>;
    type AgentTaskEntry = {
      agent: AgentInfo;
      taskIds: string[];
      completionNonce: string | null;
      tmuxOutputOffset: number | null;
      startedAt: Date;
      // Per-task timeout info — keyed by taskId for timeout enforcement
      taskTimeouts: Map<string, { timeoutMinutes: number | null; logId: string | null; logStartedAt: Date | null }>;
    };
    const byAgent = new Map<string, AgentTaskEntry>();

    for (const task of runningAgentTasks) {
      if (!task.agentId || !task.agent) continue;
      const log = task.executionLogs[0] ?? null;
      const timeoutEntry = { timeoutMinutes: task.timeoutMinutes, logId: log?.id ?? null, logStartedAt: log?.startedAt ?? null };
      const entry = byAgent.get(task.agentId);
      if (entry) {
        entry.taskIds.push(task.id);
        entry.taskTimeouts.set(task.id, timeoutEntry);
      } else {
        byAgent.set(task.agentId, {
          agent: task.agent,
          taskIds: [task.id],
          completionNonce: task.completionNonce,
          tmuxOutputOffset: task.tmuxOutputOffset,
          startedAt: task.updatedAt,
          taskTimeouts: new Map([[task.id, timeoutEntry]]),
        });
      }
    }

    await Promise.allSettled(
      [...byAgent.entries()].map(async ([agentId, { agent, taskIds, completionNonce, tmuxOutputOffset, startedAt, taskTimeouts }]) => {
        if (offlineAgentIds.has(agentId)) {
          console.log(
            `${TAG} Agent ${agent.name}: skipping idle check — offline (tmux session missing)`
          );
          return;
        }

        // ── Per-task timeout enforcement for agent tasks ─────────────────────
        const timedOutTaskIds: string[] = [];
        for (const taskId of taskIds) {
          const info = taskTimeouts.get(taskId);
          if (!info?.logStartedAt) continue;
          const timeoutMin = resolveTaskTimeout(info.timeoutMinutes, null, agent.defaultTaskTimeoutMinutes);
          const deadlineMs = info.logStartedAt.getTime() + timeoutMin * 60_000;
          if (Date.now() > deadlineMs) {
            const msg = `Execution timeout (${timeoutMin}min)`;
            const agentTimeoutAt = new Date();
            console.log(`${TAG} Agent ${agent.name}: task "${taskId}" exceeded ${timeoutMin}min timeout — failing`);
            try {
              await prisma.$transaction(async (tx) => {
                await tx.task.update({ where: { id: taskId }, data: { status: "failed" } });
                if (info.logId) {
                  await tx.executionLog.update({
                    where: { id: info.logId },
                    data: {
                      status: "failed",
                      finishedAt: agentTimeoutAt,
                      errorMessage: msg,
                      exitReason: "timeout",
                      durationMs: info.logStartedAt
                        ? agentTimeoutAt.getTime() - info.logStartedAt.getTime()
                        : null,
                    },
                  });
                }
              });
            } catch (err) {
              console.error(`${TAG} Task ${taskId}: failed to record agent timeout:`, err);
            }
            clearDispatchBackoff(taskId, backoff);
            timedOutTaskIds.push(taskId);
            console.log(`[TASK_TIMEOUT] taskId="${taskId}" agentId="${agentId}" timeoutMin=${timeoutMin}`);
            emitAudit({ entityType: "task", entityId: taskId, eventType: "task.timeout", actorType: "poller", payload: { timeoutMin, agentId } }).catch(() => {});
            const projIdTimeout = agentTaskProjectId.get(taskId);
            if (projIdTimeout) recalculateProjectProgress(projIdTimeout).catch(() => {});
            await evaluateRetry(taskId, "timeout").catch((err) => {
              console.error(`${TAG} Task ${taskId}: retry evaluation failed:`, err);
            });
          }
        }
        // Remove timed-out tasks from the set to check for completion
        const remainingTaskIds = taskIds.filter((id) => !timedOutTaskIds.includes(id));
        if (remainingTaskIds.length === 0) return;

        const firstTaskId = remainingTaskIds[0];
        const completionResult = await detectTaskCompletion(
          agent.server,
          agent.tmuxSession,
          firstTaskId,
          completionNonce ?? undefined,
          tmuxOutputOffset ?? undefined,
        );

        if (completionResult.tmuxMissing) {
          offlineAgentIds.add(agentId);
          recordAgentOffline(agentId, agentOfflineStore);
          try {
            await prisma.agent.update({
              where: { id: agentId },
              data: { status: "offline" },
            });
          } catch { /* non-fatal */ }
          console.log(
            `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' not found during completion check — ` +
            `marking offline, skipping queue advance`
          );
          emitAudit({ entityType: "agent", entityId: agentId, eventType: "agent.offline", actorType: "poller", payload: { reason: "tmux_missing_completion_check", tmuxSession: agent.tmuxSession } }).catch(() => {});
          return;
        }

        // Determine how (or whether) the task completed.
        let completedHow: string | null = null;
        if (completionResult.markerFound) {
          completedHow = "completion marker";
        } else if (completionResult.isIdle && !completionNonce) {
          completedHow = "idle prompt (no nonce)";
        } else if (completionResult.isIdle) {
          const runMs = Date.now() - startedAt.getTime();
          if (runMs >= IDLE_FALLBACK_MIN_MS) {
            completedHow = `idle fallback (no marker after ${Math.round(runMs / 60_000)}m)`;
            console.log(
              `${TAG} Agent ${agent.name}: task "${firstTaskId}" idle without nonce marker — ` +
              `using idle fallback after ${Math.round(runMs / 60_000)}m`
            );
          }
        }
        if (!completedHow) return;

        const agentFinishedAt = new Date();
        const agentPaneCapture = completionResult.paneText
          ? lastNLines(completionResult.paneText, 200)
          : null;
        const agentExitReason = completedHowToExitReason(completedHow);

        for (const taskId of remainingTaskIds) {
          try {
            await prisma.$transaction(async (tx) => {
              const latestLog = await tx.executionLog.findFirst({
                where: { taskId, status: "running", finishedAt: null },
                orderBy: { createdAt: "desc" },
                select: { id: true, startedAt: true },
              });

              await tx.task.update({
                where: { id: taskId },
                data: { status: "completed" },
              });

              if (latestLog) {
                const durationMs = agentFinishedAt.getTime() - latestLog.startedAt.getTime();
                await tx.executionLog.update({
                  where: { id: latestLog.id },
                  data: {
                    status: "completed",
                    finishedAt: agentFinishedAt,
                    durationMs,
                    exitReason: agentExitReason,
                    paneCapture: agentPaneCapture,
                  },
                });
              }
            });

            clearDispatchBackoff(taskId, backoff);
            console.log(`[TASK_FINISHED] taskId="${taskId}" agentId="${agentId}" detectedBy="${completedHow}"`);
            emitAudit({ entityType: "task", entityId: taskId, eventType: "task.completed", actorType: "poller", payload: { detectedBy: completedHow, agentId } }).catch(() => {});
            const projIdCompleted = agentTaskProjectId.get(taskId);
            if (projIdCompleted) {
              recalculateProjectProgress(projIdCompleted).catch(() => {});
              // Schedule auto-review if project has autoReviewEnabled
              prisma.project.findUnique({ where: { id: projIdCompleted }, select: { autoReviewEnabled: true } })
                .then((proj) => {
                  if (!proj?.autoReviewEnabled) return;
                  return prisma.task.update({
                    where: { id: taskId },
                    data: {
                      autoReviewEnabled: true,
                      reviewStatus: "pending",
                      reviewScheduledAt: new Date(Date.now() + 5 * 60_000),
                    },
                  });
                })
                .catch(() => {});
            }
            unblockDependents(taskId).catch(() => {});
          } catch (err) {
            console.error(`${TAG} Task ${taskId}: failed to mark agent task completed:`, err);
          }
        }

        // Release agent: mark idle before attempting queue advance.
        try {
          await prisma.agent.update({
            where: { id: agentId },
            data: { status: "idle" },
          });
          console.log(`[AGENT_RELEASED] agentId="${agentId}" name="${agent.name}"`);
        } catch (err) {
          console.error(`${TAG} Agent ${agent.name}: failed to set idle:`, err);
        }

        // Auto-advance this agent's queue after completions.
        const sessionPct = agent.claudeSessionPct ?? 0;
        const weekPct = agent.claudeWeekPct ?? 0;

        if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
          console.log(
            `${TAG} Agent ${agent.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping queue advance`
          );
          return;
        }

        const nextTask = await prisma.task.findFirst({
          where: {
            agentId,
            status: "queued",
            blockedByCount: 0,
            OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
          },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          include: { project: { select: { name: true } } },
        });

        if (!nextTask) return;

        if (shouldSkipDueToBackoff(nextTask.id, backoff)) {
          console.log(
            `${TAG} Task ${nextTask.id} ("${nextTask.title}"): skipped — backoff in effect`
          );
          return;
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
          console.log(
            `[NEXT_TASK_DISPATCHED] taskId="${nextTask.id}" title="${nextTask.title}" agentId="${agentId}"`,
          );
        } else if (outcome.reason === "ssh_failed") {
          recordDispatchFailure(nextTask.id, backoff);
          console.warn(
            `${TAG} Agent ${agent.name}: queue advance failed for task ${nextTask.id}: ${outcome.detail} — backoff applied`
          );
        } else if (outcome.reason === "tmux_missing") {
          offlineAgentIds.add(agentId);
          recordAgentOffline(agentId, agentOfflineStore);
          console.warn(
            `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' missing during dispatch — marked offline`
          );
        }
      })
    ).then((results) => {
      [...byAgent.values()].forEach(({ agent }, i) => {
        if (results[i].status === "rejected")
          console.error(`${TAG} Agent completion check for ${agent.name} threw:`, results[i].reason);
      });
    });

    // ── 3. Start queued server-direct tasks on servers with capacity ─────────
    // Per-task sessions allow parallel execution — no idle check needed.
    // Dispatch any queued task as long as the server's usage is under threshold.
    // Servers confirmed offline this cycle are skipped.
    let serversWithQueue: {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      sshKeyPath: string;
      claudePermissionMode: string;
      claudeSessionPct: number | null;
      claudeWeekPct: number | null;
      claudeSessionResetsAt: Date | null;
      claudeWeekResetsAt: Date | null;
      autoPauseEnabled: boolean;
      pausedDueToUsage: boolean;
    }[] = [];

    try {
      serversWithQueue = await prisma.server.findMany({
        where: {
          tasks: { some: { status: "queued", agentId: null } },
          NOT: { id: { in: [...offlineServerIds] } },
        },
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
          claudeSessionResetsAt: true,
          claudeWeekResetsAt: true,
          autoPauseEnabled: true,
          pausedDueToUsage: true,
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load servers with queued tasks:`, err);
    }

    await Promise.allSettled(
      serversWithQueue.map(async (srv) => {
        const sessionPct = srv.claudeSessionPct ?? 0;
        const weekPct = srv.claudeWeekPct ?? 0;

        if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
          if (srv.pausedDueToUsage) {
            // Already paused — suppress per-cycle noise, resume will fire at scheduled time.
            return;
          }
          if (srv.autoPauseEnabled) {
            const resetAt = nearestResetsAt(srv.claudeSessionResetsAt, srv.claudeWeekResetsAt);
            if (resetAt) {
              // Schedule restart + re-check POST_RESET_RESTART_BUFFER_MS after the quota
              // resets, so the fresh Claude CLI session reflects the actual new quota.
              const scheduleAt = new Date(resetAt.getTime() + POST_RESET_RESTART_BUFFER_MS);
              await upsertScheduledResume("server", srv.id, scheduleAt);
              try {
                await prisma.server.update({
                  where: { id: srv.id },
                  data: { pausedDueToUsage: true, pausedAt: new Date() },
                });
              } catch { /* non-fatal */ }
              console.log(
                `${TAG} ${srv.name}: usage at limit (session=${sessionPct}% week=${weekPct}%) — ` +
                `worker paused until ${resetAt.toISOString()}, restart scheduled at ${scheduleAt.toISOString()}`
              );
            } else {
              console.log(
                `${TAG} ${srv.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), no reset time known`
              );
            }
          } else {
            console.log(
              `${TAG} ${srv.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping`
            );
          }
          return;
        }

        // Usage back below threshold — clear any stale pause flag.
        if (srv.pausedDueToUsage) {
          try {
            await prisma.server.update({
              where: { id: srv.id },
              data: { pausedDueToUsage: false, pausedAt: null },
            });
            console.log(`${TAG} ${srv.name}: usage back below threshold — auto-unpaused`);
          } catch { /* non-fatal */ }
        }

        const nextTask = await prisma.task.findFirst({
          where: {
            serverId: srv.id,
            status: "queued",
            agentId: null,
            blockedByCount: 0,
            OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
          },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          include: { project: { select: { name: true } } },
        });

        if (!nextTask) return;

        if (shouldSkipDueToBackoff(nextTask.id, backoff)) {
          console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): skipped — backoff in effect`);
          return;
        }

        const outcome = await tryDispatchTaskToServer({
          taskId: nextTask.id,
          serverId: srv.id,
          sshConfig: { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath },
          permissionMode: srv.claudePermissionMode as ClaudePermissionMode,
          task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
          logText: `Auto-started from queue on server "${srv.name}" (${srv.host}) — mode: ${srv.claudePermissionMode}`,
        });

        if (outcome.ok) {
          clearDispatchBackoff(nextTask.id, backoff);
          console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): dispatched to server "${srv.name}"`);
        } else if (outcome.reason === "ssh_failed") {
          recordDispatchFailure(nextTask.id, backoff);
          console.warn(`${TAG} ${srv.name}: failed to start queued task ${nextTask.id}: ${outcome.detail} — backoff applied`);
        } else if (outcome.reason === "tmux_missing") {
          offlineServerIds.add(srv.id);
          console.warn(`${TAG} ${srv.name}: tmux missing during dispatch — marked offline`);
        }
      })
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected")
          console.error(
            `${TAG} Queue advance for ${serversWithQueue[i].host} threw:`,
            (r as PromiseRejectedResult).reason
          );
      });
    });

    // ── 4. Start queued tasks on idle agents that have nothing running ─────────
    // Mirrors step 3 but for agents. Uses each agent's own tmux session.
    let idleAgentsWithQueue: {
      id: string;
      name: string;
      tmuxSession: string;
      claudePermissionMode: string;
      claudeSessionPct: number | null;
      claudeWeekPct: number | null;
      claudeSessionResetsAt: Date | null;
      claudeWeekResetsAt: Date | null;
      autoPauseEnabled: boolean;
      pausedDueToUsage: boolean;
      server: {
        host: string;
        port: number;
        username: string;
        sshKeyPath: string;
      };
    }[] = [];

    try {
      idleAgentsWithQueue = await prisma.agent.findMany({
        where: {
          tasks: { some: { status: "queued" } },
          AND: { tasks: { none: { status: "running" } } },
          // Skip agents already handled by the completion loop above,
          // and agents confirmed offline this cycle.
          NOT: { id: { in: [...byAgent.keys(), ...offlineAgentIds] } },
        },
        select: {
          id: true,
          name: true,
          tmuxSession: true,
          claudePermissionMode: true,
          claudeSessionPct: true,
          claudeWeekPct: true,
          claudeSessionResetsAt: true,
          claudeWeekResetsAt: true,
          autoPauseEnabled: true,
          pausedDueToUsage: true,
          server: {
            select: { host: true, port: true, username: true, sshKeyPath: true },
          },
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load queued-only agents:`, err);
    }

    await Promise.allSettled(
      idleAgentsWithQueue.map(async (agent) => {
        const sessionPct = agent.claudeSessionPct ?? 0;
        const weekPct = agent.claudeWeekPct ?? 0;

        if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
          if (agent.pausedDueToUsage) {
            // Already paused — suppress per-cycle noise.
            return;
          }
          if (agent.autoPauseEnabled) {
            const resetAt = nearestResetsAt(agent.claudeSessionResetsAt, agent.claudeWeekResetsAt);
            if (resetAt) {
              const scheduleAt = new Date(resetAt.getTime() + POST_RESET_RESTART_BUFFER_MS);
              await upsertScheduledResume("agent", agent.id, scheduleAt);
              try {
                await prisma.agent.update({
                  where: { id: agent.id },
                  data: { pausedDueToUsage: true, pausedAt: new Date() },
                });
              } catch { /* non-fatal */ }
              console.log(
                `${TAG} Agent ${agent.name}: usage at limit (session=${sessionPct}% week=${weekPct}%) — ` +
                `worker paused until ${resetAt.toISOString()}, restart scheduled at ${scheduleAt.toISOString()}`
              );
            } else {
              console.log(
                `${TAG} Agent ${agent.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), no reset time known`
              );
            }
          } else {
            console.log(
              `${TAG} Agent ${agent.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping`
            );
          }
          return;
        }

        // Usage back below threshold — clear any stale pause flag.
        if (agent.pausedDueToUsage) {
          try {
            await prisma.agent.update({
              where: { id: agent.id },
              data: { pausedDueToUsage: false, pausedAt: null },
            });
            console.log(`${TAG} Agent ${agent.name}: usage back below threshold — auto-unpaused`);
          } catch { /* non-fatal */ }
        }

        const idleResult = await detectClaudeIdle(agent.server, agent.tmuxSession);

        if (idleResult.tmuxMissing) {
          offlineAgentIds.add(agent.id);
          recordAgentOffline(agent.id, agentOfflineStore);
          try {
            await prisma.agent.update({
              where: { id: agent.id },
              data: { status: "offline" },
            });
          } catch { /* non-fatal */ }
          console.log(
            `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' not found — ` +
            `marked offline, skipping queued task`
          );
          emitAudit({ entityType: "agent", entityId: agent.id, eventType: "agent.offline", actorType: "poller", payload: { reason: "tmux_missing_queue_check", tmuxSession: agent.tmuxSession } }).catch(() => {});
          return;
        }

        if (!idleResult.isIdle) {
          console.log(
            `${TAG} Agent ${agent.name}: has queued tasks but Claude is not idle yet` +
            (idleResult.error ? ` — error: ${idleResult.error}` : "") +
            (idleResult.paneText
              ? `\n  pane tail: ${JSON.stringify(
                  idleResult.paneText.split("\n").filter(l => l.trim()).slice(-4)
                )}`
              : "")
          );
          return;
        }

        const nextTask = await prisma.task.findFirst({
          where: {
            agentId: agent.id,
            status: "queued",
            OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
          },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          include: { project: { select: { name: true } } },
        });

        if (!nextTask) return;

        if (shouldSkipDueToBackoff(nextTask.id, backoff)) {
          console.log(
            `${TAG} Task ${nextTask.id} ("${nextTask.title}"): skipped — backoff in effect`
          );
          return;
        }

        const outcome = await tryDispatchTaskToAgent({
          taskId: nextTask.id,
          agentId: agent.id,
          sshConfig: agent.server,
          tmuxSession: agent.tmuxSession,
          task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
          logText: `Auto-started from queue on agent "${agent.name}" — mode: ${agent.claudePermissionMode}`,
        });

        if (outcome.ok) {
          clearDispatchBackoff(nextTask.id, backoff);
          console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): dispatched from idle-agent queue`);
        } else if (outcome.reason === "ssh_failed") {
          recordDispatchFailure(nextTask.id, backoff);
          console.warn(
            `${TAG} Agent ${agent.name}: failed to start queued task ${nextTask.id}: ${outcome.detail} — backoff applied`
          );
        } else if (outcome.reason === "tmux_missing") {
          offlineAgentIds.add(agent.id);
          recordAgentOffline(agent.id, agentOfflineStore);
          console.warn(
            `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' missing during dispatch — marked offline`
          );
        }
      })
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected")
          console.error(
            `${TAG} Idle-agent queue check for ${idleAgentsWithQueue[i].name} threw:`,
            (r as PromiseRejectedResult).reason
          );
      });
    });

    // ── 5. Zombie task detection (every cycle) ──────────────────────────────
    try {
      await detectZombieTasks();
    } catch (err) {
      console.error(`${TAG} Zombie detection threw:`, err);
    }

    // ── 6. Worker health checks + auto-recovery (every 5 cycles ≈ 5 min) ───
    g._pollerCycleCount = (g._pollerCycleCount ?? 0) + 1;
    if (g._pollerCycleCount % 5 === 0) {
      console.log(`${TAG} Running worker health checks (cycle ${g._pollerCycleCount})`);
      try {
        await runHealthChecks();
      } catch (err) {
        console.error(`${TAG} Health check cycle threw:`, err);
      }
      // Auto-recovery runs after health checks so consecutiveFailures are fresh.
      try {
        await runAutoRecovery();
      } catch (err) {
        console.error(`${TAG} Auto-recovery sweep threw:`, err);
      }
    }

    // ── 7. Project progress reconciliation (every 10 cycles ≈ 10 min) ────────
    if (g._pollerCycleCount % 10 === 0) {
      try {
        await reconcileAllProjects();
      } catch (err) {
        console.error(`${TAG} Project progress reconciliation threw:`, err);
      }
    }

    // ── 8. Nightly log archival (1 AM UTC, once per day) ─────────────────────
    if (shouldRunNightlyArchival(g._lastArchivalDate ?? null)) {
      try {
        const { archived } = await archiveOldLogs();
        g._lastArchivalDate = new Date().toISOString().slice(0, 10);
        if (archived > 0) {
          console.log(`${TAG} Nightly archival complete — ${archived} logs archived`);
        }
      } catch (err) {
        console.error(`${TAG} Nightly log archival threw:`, err);
      }
    }

    // ── 9. Auto daily report (1 AM UTC, once per day) ────────────────────────
    await runDailyReportIfNeeded();

    // ── 10. Weekly analytics (Monday 1 AM UTC, once per week) ────────────────
    await runWeeklyAnalyticsIfNeeded();

    // ── 11. Auto-review queue (every cycle, max 3 reviews) ───────────────────
    try {
      await processReviewQueue(3);
    } catch (err) {
      console.error(`${TAG} processReviewQueue threw:`, err);
    }

    // ── 12. Project improvement scans (daily at 2 AM UTC, frequency-gated) ───
    await runProjectScansIfNeeded();

    // ── 13. Continuous improvement engine (advance cycles + start due cycles) ─
    try {
      await advanceImprovementCycles();
    } catch (err) {
      console.error(`${TAG} advanceImprovementCycles threw:`, err);
    }
    try {
      await startDueImprovementCycles();
    } catch (err) {
      console.error(`${TAG} startDueImprovementCycles threw:`, err);
    }

    console.log(`${TAG} poll end`);
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────
  // Use globalThis so the running flag survives Next.js HMR module re-evaluation.

  async function tick() {
    if (g._pollerRunning) {
      console.log(`${TAG} Previous poll still running — skipping this tick`);
      return;
    }
    g._pollerRunning = true;
    try {
      await runCheck();
    } catch (err) {
      console.error(`${TAG} Unhandled error in poll cycle — process protected:`, err);
    } finally {
      g._pollerRunning = false;
    }
  }

  // First check 15 s after server start (DB pool warm-up), then every 60 s.
  setTimeout(() => tick(), 15_000);
  setInterval(() => tick(), 60_000);

  console.log(
    `${TAG} Background poller registered (first check in 15 s, then every 60 s)`
  );
}
