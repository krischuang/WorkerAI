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

import { validateSshKeyEnv, validateArtifactStoragePath } from "./lib/startup-validation";
import { prisma } from "./lib/prisma";
import { setAdminNonce } from "./lib/admin-nonce-cache";
import { setAdminOtpBucket } from "./lib/api-rate-limit";
import {
  fetchClaudeUsageViaTmux,
  fetchClaudeUsageReliable,
  detectClaudeIdle,
  detectTaskCompletion,
  killTaskTmuxSession,
  launchClaudeInTmux,
  type ClaudePermissionMode,
} from "./lib/ssh-claude-tmux";
import { recordUsageSnapshot } from "./lib/usage-snapshot-service";
import { applyValidationGate } from "./lib/validation-gate";
import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "./lib/task-dispatch";
import { USAGE_THRESHOLD, IDLE_FALLBACK_MIN_MS, POST_RESET_RESTART_BUFFER_MS, estimateCostUsd, AGENT_COOLDOWN_MS, LOG_TAIL_LINES } from "./lib/constants";
import { readRunCompletion, readLogTail, tmuxSessionExists } from "./lib/run-completion";
import { parseTokenCounts } from "./lib/usage-parser";
import { resolveTaskTimeout, TASK_TYPE_TIMEOUT_KEYS, type TaskTypeKey } from "./lib/task-timeout";
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
  pruneHighVolumeTables,
  shouldRunNightlyArchival,
  completedHowToExitReason,
  lastNLines,
} from "./lib/execution-log-archival";
import { updateAllServerCapacity } from "./lib/server-capacity";
import { generateDailyReport, todaysReportExists } from "./lib/daily-report-service";
import { generateWeeklyAnalytics, priorWeekStart, weeklyAnalyticsExists } from "./lib/weekly-analytics-service";
import { generateWeeklyReport, mondayOfWeek, weeklyReportExists } from "./lib/weekly-report-service";
import { generateMonthlyReport, firstOfMonth, monthlyReportExists } from "./lib/monthly-report-service";
import { unblockDependents } from "./lib/task-dependency";
import { processReviewQueue, autoAssignQueuedTasks } from "./lib/task-service";
import { runDueProjectScans } from "./lib/project-scan-service";
import { runDueImprovementReviews } from "./lib/improvement-review-service";
import { advanceImprovementCycles, startDueImprovementCycles } from "./lib/improvement-cycle-service";
import { emitNotification, emitStalePendingNotification } from "./lib/notification";
import { scrubPaneCapture } from "./lib/pane-scrubber";
import { getDecryptedTaskSecrets } from "./lib/task-secrets";

/** Returns plaintext values of all TaskSecrets for a task (for pane scrubbing). */
async function taskSecretValues(taskId: string): Promise<string[]> {
  return getDecryptedTaskSecrets(taskId).then(s => s.map(r => r.value)).catch(() => []);
}
/** Collects plaintext values across multiple tasks (for shared-session legacy dispatch). */
async function multiTaskSecretValues(taskIds: string[]): Promise<string[]> {
  const all = await Promise.all(taskIds.map(id => getDecryptedTaskSecrets(id).catch(() => [])));
  return all.flat().map(r => r.value);
}
import { runDueScheduledTasks } from "./lib/scheduled-task-service";
import {
  setRateLimitEnabled,
  setAdminLoginBucket,
  applyAdminLoginRestartLockout,
} from "./lib/api-rate-limit";
import { runSelfHealingCycle } from "./lib/self-healing/self-healing-cycle";

const TAG = "[usage-poller]";

// Preserve state across Next.js HMR module re-evaluations.
const g = globalThis as unknown as {
  _usagePollerStarted?: boolean;
  _pollerRunning?: boolean;
  _shutdownRequested?: boolean;
  _dispatchBackoff?: Map<string, BackoffEntry>;
  _agentOfflineStore?: Map<string, number>;
  _pollerCycleCount?: number;
  _lastArchivalDate?: string | null;
  _lastDailyReportDate?: string | null;
  _lastWeeklyReportDate?: string | null;
  _lastMonthlyReportDate?: string | null;
  _lastWeeklyAnalyticsDate?: string | null;
  _lastProjectScanDate?: string | null;
  _lastImprovementReviewDate?: string | null;
  // zombie-detection pane-line baseline (owned by lib/zombie-detection.ts)
  _zombiePaneLines?: Map<string, number>;
  // Server/agent IDs whose Claude CLI session must be restarted before the next
  // /usage check (populated when a scheduled resume fires after a usage reset).
  _pendingServerRestarts?: Set<string>;
  _pendingAgentRestarts?: Set<string>;
};

if (!g._usagePollerStarted) {
  g._usagePollerStarted = true;
  validateSshKeyEnv();
  validateArtifactStoragePath();
  if (!g._dispatchBackoff) g._dispatchBackoff = new Map();
  if (!g._agentOfflineStore) g._agentOfflineStore = new Map();
  if (g._pollerCycleCount === undefined) g._pollerCycleCount = 0;
  if (g._lastArchivalDate === undefined) g._lastArchivalDate = null;
  if (g._lastDailyReportDate === undefined) g._lastDailyReportDate = null;
  if (g._lastWeeklyReportDate === undefined) g._lastWeeklyReportDate = null;
  if (g._lastMonthlyReportDate === undefined) g._lastMonthlyReportDate = null;
  if (g._lastWeeklyAnalyticsDate === undefined) g._lastWeeklyAnalyticsDate = null;
  if (g._lastProjectScanDate === undefined) g._lastProjectScanDate = null;
  if (g._lastImprovementReviewDate === undefined) g._lastImprovementReviewDate = null;
  if (!g._pendingServerRestarts) g._pendingServerRestarts = new Set();
  if (!g._pendingAgentRestarts) g._pendingAgentRestarts = new Set();
  if (g._shutdownRequested === undefined) g._shutdownRequested = false;

  // Load rate_limit_enabled from SystemConfig and populate the in-process cache.
  prisma.systemConfig.findUnique({ where: { key: "rate_limit_enabled" } })
    .then((row) => {
      if (row) setRateLimitEnabled(row.value !== "false");
    })
    .catch(() => { /* leave default (true) if DB is not yet ready */ });

  // ── Admin session nonce restoration ────────────────────────────────────
  // Load the current session nonce so the middleware can validate admin
  // cookies without a per-request DB round-trip.
  prisma.systemConfig.findUnique({ where: { key: "admin_session_nonce" } })
    .then((row) => { if (row) setAdminNonce(row.value); })
    .catch(() => { /* non-fatal — nonce defaults to "" (legacy compat) */ });

  // ── Admin-OTP rate-limit crash resilience ──────────────────────────────
  // Restore OTP brute-force counters so a server restart cannot reset them.
  prisma.systemConfig.findUnique({ where: { key: "rl_bucket_admin-otp" } })
    .then((row) => {
      if (row) {
        try {
          const parsed: unknown = JSON.parse(row.value);
          if (Array.isArray(parsed)) setAdminOtpBucket(parsed as number[]);
        } catch { /* ignore corrupt entry */ }
      }
    })
    .catch(() => { /* non-fatal */ });

  // ── Admin-login rate-limit crash resilience ─────────────────────────────
  // Restore any previously persisted admin-login bucket so a server restart
  // cannot be used to reset brute-force attempt counters.
  // If RESTART_LOCKOUT_MINUTES is set, also impose a minimum post-restart
  // cooldown so the first login attempt after restart is blocked until the
  // window expires, closing the tiny gap that exists before the bucket is
  // fully restored from DB.
  prisma.systemConfig.findUnique({ where: { key: "rl_bucket_admin-login" } })
    .then((row) => {
      if (row) {
        try {
          const parsed: unknown = JSON.parse(row.value);
          if (Array.isArray(parsed)) {
            setAdminLoginBucket(parsed as number[]);
          }
        } catch { /* ignore corrupt entry */ }
      }
      const lockoutMin = Number(process.env.RESTART_LOCKOUT_MINUTES ?? "0");
      if (lockoutMin > 0) {
        const lockoutMs = lockoutMin * 60_000;
        applyAdminLoginRestartLockout(lockoutMs);
        console.warn(
          `[startup] RESTART_LOCKOUT_MINUTES=${lockoutMin}: admin-login locked out ` +
          `for ${lockoutMin} min after restart (crash-resilience mitigation).`,
        );
      }
    })
    .catch(() => { /* non-fatal — in-memory default is still active */ });

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

async function runImprovementReviewsIfNeeded() {
  const now = new Date();
  // Run once per day at or after 4 AM UTC (staggered from the gap-analysis scan at 2 AM)
  if (now.getUTCHours() < 4) return;
  const todayKey = now.toISOString().slice(0, 10);
  if (g._lastImprovementReviewDate === todayKey) return;
  g._lastImprovementReviewDate = todayKey;
  try {
    await runDueImprovementReviews();
  } catch (err) {
    console.error(`${TAG} runDueImprovementReviews threw:`, err);
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

async function runWeeklyReportIfNeeded() {
  const now = new Date();
  // Only run on Mondays at or after 2 AM UTC
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 2) return;
  const weekKey = now.toISOString().slice(0, 10);
  if (g._lastWeeklyReportDate === weekKey) return;
  try {
    const weekStart = mondayOfWeek(now);
    const exists = await weeklyReportExists(weekStart);
    if (!exists) {
      await generateWeeklyReport(weekStart, "auto");
      console.log(`${TAG} Auto weekly report generated for week starting ${weekKey}`);
    }
    g._lastWeeklyReportDate = weekKey;
  } catch (err) {
    console.error(`${TAG} Auto weekly report threw:`, err);
  }
}

async function runMonthlyReportIfNeeded() {
  const now = new Date();
  // Only run on the 1st of each month at or after 3 AM UTC
  if (now.getUTCDate() !== 1 || now.getUTCHours() < 3) return;
  const monthKey = now.toISOString().slice(0, 7); // "YYYY-MM"
  if (g._lastMonthlyReportDate === monthKey) return;
  try {
    const monthStart = firstOfMonth(now);
    const exists = await monthlyReportExists(monthStart);
    if (!exists) {
      await generateMonthlyReport(monthStart, "auto");
      console.log(`${TAG} Auto monthly report generated for ${monthKey}`);
    }
    g._lastMonthlyReportDate = monthKey;
  } catch (err) {
    console.error(`${TAG} Auto monthly report threw:`, err);
  }
}

/**
 * Try to compute tokenCount and actualCostUsd from a /usage raw output string.
 * Returns null fields if token counts are absent in the raw output.
 */
function computeCostFromRaw(
  rawUsage: string | null,
): { tokenCount: number | null; actualCostUsd: number | null } {
  if (!rawUsage) return { tokenCount: null, actualCostUsd: null };
  const { inputTokens, outputTokens, modelName } = parseTokenCounts(rawUsage);
  if (inputTokens == null && outputTokens == null) return { tokenCount: null, actualCostUsd: null };
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const total = input + output;
  const cost = estimateCostUsd(input, output, modelName ?? "default");
  return { tokenCount: total, actualCostUsd: Math.round(cost * 1_000_000) / 1_000_000 };
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

    // ── 0. Fetch per-taskType timeout defaults from SystemConfig ──────────────
    const taskTypeTimeoutMinutes: Partial<Record<TaskTypeKey, number>> = {};
    try {
      const timeoutKeys = Object.values(TASK_TYPE_TIMEOUT_KEYS);
      const timeoutRows = await prisma.systemConfig.findMany({
        where: { key: { in: timeoutKeys } },
        select: { key: true, value: true },
      });
      for (const row of timeoutRows) {
        const typeEntry = Object.entries(TASK_TYPE_TIMEOUT_KEYS).find(([, v]) => v === row.key);
        if (typeEntry) {
          const parsed = parseInt(row.value, 10);
          if (!isNaN(parsed) && parsed > 0) {
            taskTypeTimeoutMinutes[typeEntry[0] as TaskTypeKey] = parsed;
          }
        }
      }
    } catch (err) {
      console.error(`${TAG} Failed to load per-taskType timeout config:`, err);
    }

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
            // The server is reachable (SSH worked) but has no server-level Claude
            // session.  Don't mark it failed — agents on this server operate
            // independently and server-direct tasks use per-task sessions that
            // don't depend on this shared session.
            console.warn(
              `${TAG} ${srv.name}: no server-level Claude tmux session '${srv.tmuxSession}' — usage skipped (agents unaffected)`
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

        const result = await fetchClaudeUsageReliable(agent.server, agent.tmuxSession, "tmux_capture");
        // Always record a snapshot — success, failure, or low confidence — so the full capture
        // history is inspectable. Only updates Agent.claudeSessionPct/claudeWeekPct etc. when
        // result.confidence is "high" or "medium"; see lib/usage-snapshot-service.ts.
        const { agentUpdated } = await recordUsageSnapshot(agent.id, result, "tmux_capture");

        if (result.success) {
          clearAgentOffline(agent.id, agentOfflineStore);

          if (!agentUpdated) {
            // Claude responded but the parser wasn't confident enough to trust the numbers —
            // the agent is reachable (so mark idle) but the cached pct fields are left as-is.
            await prisma.agent.update({ where: { id: agent.id }, data: { status: "idle" } }).catch(() => {});
            console.warn(
              `${TAG} Agent ${agent.name}: usage captured with confidence="${result.confidence}" — ` +
              `Agent fields not updated (${result.warnings.join("; ") || "no warnings"})`
            );
          } else {
            const freshSession = result.parsed.sessionPct ?? 0;
            const freshWeek = result.parsed.weekPct ?? 0;
            const isUnblocked = freshSession < USAGE_THRESHOLD && freshWeek < USAGE_THRESHOLD;

            await prisma.agent.update({
              where: { id: agent.id },
              data: {
                status: "idle",
                ...(agent.pausedDueToUsage && isUnblocked ? { pausedDueToUsage: false, pausedAt: null } : {}),
              },
            });

            if (needsRestart) {
              if (isUnblocked) {
                console.log(
                  `${TAG} Agent ${agent.name}: fresh usage fetched (session=${freshSession}% week=${freshWeek}%, confidence=${result.confidence}) — worker resumed`
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
                `${TAG} Agent ${agent.name}: session=${freshSession}% week=${freshWeek}% (confidence=${result.confidence})`
              );
              if (agent.pausedDueToUsage && isUnblocked) {
                console.log(`${TAG} Agent ${agent.name}: usage recovered — worker resumed`);
              }
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
      title: string;
      isAutonomous: boolean;
      serverId: string | null;
      runId: string | null;
      completionNonce: string | null;
      tmuxOutputOffset: number | null;
      taskTmuxSession: string | null;
      taskType: string;
      timeoutMinutes: number | null;
      updatedAt: Date;
      disablePaneCapture: boolean;
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
        claudeUsageRaw: string | null;
        defaultTaskTimeoutMinutes: number | null;
      } | null;
    }[] = [];

    try {
      runningTasks = await prisma.task.findMany({
        where: { status: "running", agentId: null },
        select: {
          id: true,
          projectId: true,
          title: true,
          isAutonomous: true,
          serverId: true,
          runId: true,
          completionNonce: true,
          tmuxOutputOffset: true,
          taskTmuxSession: true,
          taskType: true,
          timeoutMinutes: true,
          updatedAt: true,
          disablePaneCapture: true,
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
              claudeUsageRaw: true,
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
            taskTypeTimeoutMinutes[task.taskType as TaskTypeKey],
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
              await prisma.task.update({ where: { id: task.id }, data: { taskTmuxSession: null } }).catch(() => {});
            }
            clearDispatchBackoff(task.id, backoff);
            console.log(`[TASK_TIMEOUT] taskId="${task.id}" timeoutMin=${timeoutMin}`);
            emitAudit({ entityType: "task", entityId: task.id, eventType: "task.timeout", actorType: "poller", payload: { timeoutMin, serverId } }).catch(() => {});
            emitNotification(task.id, "task.failed").catch(() => {});
            recalculateProjectProgress(task.projectId).catch(() => {});
            await evaluateRetry(task.id, "timeout").catch((err) => {
              console.error(`${TAG} Task ${task.id}: retry evaluation failed:`, err);
            });
            return;
          }
        }

        const sshConfig = { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath };

        // ── File-based completion detection (new tasks with runId) ────────────
        if (task.runId) {
          const doneResult = await readRunCompletion(sshConfig, task.runId);

          if (doneResult.found && doneResult.data) {
            // Done-file written — task has exited.
            const { exitCode, finishedAt: finishedAtStr } = doneResult.data;
            const newStatus = exitCode === 0 ? "completed" : "failed";
            const finishedAt = new Date(finishedAtStr);
            const logTail = task.disablePaneCapture
              ? null
              : (await readLogTail(sshConfig, task.runId, LOG_TAIL_LINES)) || null;
            const costData = computeCostFromRaw(srv.claudeUsageRaw ?? null);
            const secretVals = logTail ? await taskSecretValues(task.id) : [];

            try {
              await prisma.$transaction(async (tx) => {
                const latestLog = await tx.executionLog.findFirst({
                  where: { taskId: task.id, status: "running", finishedAt: null },
                  orderBy: { createdAt: "desc" },
                  select: { id: true, startedAt: true },
                });
                await tx.task.update({ where: { id: task.id }, data: { status: newStatus } });
                if (latestLog) {
                  await tx.executionLog.update({
                    where: { id: latestLog.id },
                    data: {
                      status: newStatus,
                      finishedAt,
                      durationMs: finishedAt.getTime() - latestLog.startedAt.getTime(),
                      exitReason: exitCode === 0 ? "done_file" : "done_file_nonzero",
                      paneCapture: logTail ? scrubPaneCapture(logTail, secretVals) : null,
                      errorMessage: exitCode !== 0 ? `Claude exited with code ${exitCode}` : null,
                      tokenCount: costData.tokenCount,
                      actualCostUsd: costData.actualCostUsd,
                    },
                  });
                }
              });
              clearDispatchBackoff(task.id, backoff);
              console.log(`[TASK_FINISHED] taskId="${task.id}" detectedBy="done_file" exitCode=${exitCode} status="${newStatus}"`);
              emitAudit({ entityType: "task", entityId: task.id, eventType: `task.${newStatus}`, actorType: "poller", payload: { detectedBy: "done_file", exitCode, serverId } }).catch(() => {});
              emitNotification(task.id, newStatus === "completed" ? "task.completed" : "task.failed").catch(() => {});
              recalculateProjectProgress(task.projectId).catch(() => {});
              if (newStatus === "completed") {
                unblockDependents(task.id).catch(() => {});
                prisma.project.findUnique({ where: { id: task.projectId }, select: { autoReviewEnabled: true } })
                  .then((proj) => {
                    if (!proj?.autoReviewEnabled) return;
                    return prisma.task.update({
                      where: { id: task.id },
                      data: { autoReviewEnabled: true, reviewStatus: "pending", reviewScheduledAt: new Date(Date.now() + 5 * 60_000) },
                    });
                  }).catch(() => {});
              } else {
                await evaluateRetry(task.id, "done_file_nonzero").catch((err) => {
                  console.error(`${TAG} Task ${task.id}: retry evaluation failed:`, err);
                });
              }
              if (task.taskTmuxSession) {
                await killTaskTmuxSession(sshConfig, task.id).catch(() => {});
                // Clear after kill so the orphan sweep doesn't re-process this task.
                await prisma.task.update({ where: { id: task.id }, data: { taskTmuxSession: null } }).catch(() => {});
              }
            } catch (err) {
              console.error(`${TAG} Task ${task.id}: failed to record done-file completion:`, err);
            }
            return; // done — do not fall through to tmux detection
          }

          // Done-file not yet written — check if the tmux session still exists.
          const sessionAlive = task.taskTmuxSession
            ? await tmuxSessionExists(sshConfig, task.taskTmuxSession)
            : false;

          if (!sessionAlive) {
            // Session is gone but no done-file — wrapper crashed or server rebooted.
            console.log(
              `${TAG} ${srv.name}: task "${task.id}" — session gone, no done-file → needs_review`
            );
            try {
              await prisma.$transaction(async (tx) => {
                await tx.task.update({ where: { id: task.id }, data: { status: "needs_review" } });
                const latestLog = await tx.executionLog.findFirst({
                  where: { taskId: task.id, status: "running", finishedAt: null },
                  orderBy: { createdAt: "desc" },
                  select: { id: true, startedAt: true },
                });
                if (latestLog) {
                  const now = new Date();
                  await tx.executionLog.update({
                    where: { id: latestLog.id },
                    data: {
                      status: "failed",
                      finishedAt: now,
                      durationMs: now.getTime() - latestLog.startedAt.getTime(),
                      exitReason: "needs_review",
                      errorMessage: "tmux session gone before done-file was written — needs manual review",
                    },
                  });
                }
              });
              emitAudit({ entityType: "task", entityId: task.id, eventType: "task.needs_review", actorType: "poller", payload: { reason: "session_gone_no_done_file", serverId } }).catch(() => {});
              emitNotification(task.id, "task.failed").catch(() => {});
              recalculateProjectProgress(task.projectId).catch(() => {});
            } catch (err) {
              console.error(`${TAG} Task ${task.id}: failed to mark needs_review:`, err);
            }
            return;
          }

          // Session alive, done-file not yet written — still running, wait.
          return;
        }

        // ── Legacy tmux pane detection (tasks without runId) ─────────────────
        // Use the task's own session; fall back to server session for legacy tasks.
        const checkSession = task.taskTmuxSession ?? srv.tmuxSession;

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
          const paneCapture = (!task.disablePaneCapture && completionResult.paneText)
            ? scrubPaneCapture(lastNLines(completionResult.paneText, 200), await taskSecretValues(task.id))
            : null;
          const exitReason = completedHowToExitReason(completedHow);

          // Compute cost from current server usage snapshot (after task ran)
          const costData = computeCostFromRaw(srv.claudeUsageRaw ?? null);

          // Autonomous tasks must prove their work with a [WORKERAI_VALIDATION] block before
          // they're allowed to complete — see lib/validation-gate.ts.
          const gate = await applyValidationGate({
            taskId: task.id,
            projectId: task.projectId,
            title: task.title,
            isAutonomous: task.isAutonomous,
            paneText: completionResult.paneText,
            expectedNonce: task.completionNonce,
          });
          const finalStatus: "completed" | "failed" = gate.allowed ? "completed" : "failed";
          const finalExitReason = gate.allowed ? exitReason : "validation_failed";

          await prisma.$transaction(async (tx) => {
            const latestLog = await tx.executionLog.findFirst({
              where: { taskId: task.id, status: "running", finishedAt: null },
              orderBy: { createdAt: "desc" },
              select: { id: true, startedAt: true },
            });
            if (gate.allowed) {
              await tx.task.update({ where: { id: task.id }, data: { status: "completed" } });
            }
            if (latestLog) {
              const durationMs = finishedAt.getTime() - latestLog.startedAt.getTime();
              await tx.executionLog.update({
                where: { id: latestLog.id },
                data: {
                  status: finalStatus,
                  finishedAt,
                  durationMs,
                  exitReason: finalExitReason,
                  paneCapture,
                  tokenCount: costData.tokenCount,
                  actualCostUsd: costData.actualCostUsd,
                },
              });
            }
          });

          if (!gate.allowed) {
            console.log(`[TASK_FINISHED] taskId="${task.id}" detectedBy="${completedHow}" blockedByValidationGate="${gate.validationStatus}"`);
            emitNotification(task.id, "task.failed").catch(() => {});
            recalculateProjectProgress(task.projectId).catch(() => {});
            if (task.taskTmuxSession) {
              await killTaskTmuxSession(sshConfig, task.id);
              await prisma.task.update({ where: { id: task.id }, data: { taskTmuxSession: null } }).catch(() => {});
            }
            return;
          }

          clearDispatchBackoff(task.id, backoff);
          console.log(`[TASK_FINISHED] taskId="${task.id}" detectedBy="${completedHow}"`);
          emitAudit({ entityType: "task", entityId: task.id, eventType: "task.completed", actorType: "poller", payload: { detectedBy: completedHow, serverId } }).catch(() => {});
          emitNotification(task.id, "task.completed").catch(() => {});
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
            await prisma.task.update({ where: { id: task.id }, data: { taskTmuxSession: null } }).catch(() => {});
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
      title: string;
      isAutonomous: boolean;
      agentId: string | null;
      runId: string | null;
      completionNonce: string | null;
      tmuxOutputOffset: number | null;
      taskTmuxSession: string | null;
      taskType: string;
      timeoutMinutes: number | null;
      updatedAt: Date;
      disablePaneCapture: boolean;
      executionLogs: { id: string; startedAt: Date; status: string; finishedAt: Date | null }[];
      agent: {
        id: string;
        name: string;
        tmuxSession: string;
        workDir: string;
        claudePermissionMode: string;
        claudeSessionPct: number | null;
        claudeWeekPct: number | null;
        claudeUsageRaw: string | null;
        defaultTaskTimeoutMinutes: number | null;
        maxConcurrentTasks: number;
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
          title: true,
          isAutonomous: true,
          agentId: true,
          runId: true,
          completionNonce: true,
          tmuxOutputOffset: true,
          taskTmuxSession: true,
          taskType: true,
          timeoutMinutes: true,
          updatedAt: true,
          disablePaneCapture: true,
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
              workDir: true,
              claudePermissionMode: true,
              claudeSessionPct: true,
              claudeWeekPct: true,
              claudeUsageRaw: true,
              defaultTaskTimeoutMinutes: true,
              maxConcurrentTasks: true,
              tags: true,
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
    type TaskTimeoutInfo = {
      timeoutMinutes: number | null;
      taskType: string;
      logId: string | null;
      logStartedAt: Date | null;
      // Per-task session fields (set when task uses an isolated tmux session)
      runId: string | null;
      completionNonce: string | null;
      tmuxOutputOffset: number | null;
      taskTmuxSession: string | null;
      taskStartedAt: Date;
      title: string;
      isAutonomous: boolean;
    };
    type AgentTaskEntry = {
      agent: AgentInfo;
      taskIds: string[];
      completionNonce: string | null;
      tmuxOutputOffset: number | null;
      startedAt: Date;
      disablePaneCapture: boolean;
      taskTimeouts: Map<string, TaskTimeoutInfo>;
    };
    const byAgent = new Map<string, AgentTaskEntry>();

    for (const task of runningAgentTasks) {
      if (!task.agentId || !task.agent) continue;
      const log = task.executionLogs[0] ?? null;
      const timeoutEntry: TaskTimeoutInfo = {
        timeoutMinutes: task.timeoutMinutes,
        taskType: task.taskType,
        logId: log?.id ?? null,
        logStartedAt: log?.startedAt ?? null,
        runId: task.runId,
        completionNonce: task.completionNonce,
        tmuxOutputOffset: task.tmuxOutputOffset,
        taskTmuxSession: task.taskTmuxSession,
        taskStartedAt: task.updatedAt,
        title: task.title,
        isAutonomous: task.isAutonomous,
      };
      const entry = byAgent.get(task.agentId);
      if (entry) {
        entry.taskIds.push(task.id);
        entry.taskTimeouts.set(task.id, timeoutEntry);
        if (task.disablePaneCapture) entry.disablePaneCapture = true;
      } else {
        byAgent.set(task.agentId, {
          agent: task.agent,
          taskIds: [task.id],
          completionNonce: task.completionNonce,
          tmuxOutputOffset: task.tmuxOutputOffset,
          startedAt: task.updatedAt,
          disablePaneCapture: task.disablePaneCapture,
          taskTimeouts: new Map([[task.id, timeoutEntry]]),
        });
      }
    }

    await Promise.allSettled(
      [...byAgent.entries()].map(async ([agentId, { agent, taskIds, completionNonce, tmuxOutputOffset, startedAt, disablePaneCapture: agentGroupDisablePaneCapture, taskTimeouts }]) => {
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
          const timeoutMin = resolveTaskTimeout(info.timeoutMinutes, null, agent.defaultTaskTimeoutMinutes, taskTypeTimeoutMinutes[info.taskType as TaskTypeKey]);
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
            emitNotification(taskId, "task.failed").catch(() => {});
            const projIdTimeout = agentTaskProjectId.get(taskId);
            if (projIdTimeout) recalculateProjectProgress(projIdTimeout).catch(() => {});
            await evaluateRetry(taskId, "timeout").catch((err) => {
              console.error(`${TAG} Task ${taskId}: retry evaluation failed:`, err);
            });
          }
        }
        // Remove timed-out tasks from the set to check for completion
        const remainingTaskIds = taskIds.filter((id) => !timedOutTaskIds.includes(id));

        // Kill per-task sessions for timed-out tasks
        for (const taskId of timedOutTaskIds) {
          const info = taskTimeouts.get(taskId);
          if (info?.taskTmuxSession) {
            await killTaskTmuxSession(agent.server, taskId).catch(() => {});
            await prisma.task.update({ where: { id: taskId }, data: { taskTmuxSession: null } }).catch(() => {});
          }
        }

        if (remainingTaskIds.length === 0) {
          // All tasks timed out — fall through to queue advance below.
        } else {
          // Separate tasks that use per-task sessions from legacy shared-session tasks.
          const perTaskRemaining = remainingTaskIds.filter((id) => !!taskTimeouts.get(id)?.taskTmuxSession);
          const legacyRemaining  = remainingTaskIds.filter((id) => !taskTimeouts.get(id)?.taskTmuxSession);

          const agentCostData = computeCostFromRaw(agent.claudeUsageRaw ?? null);
          const completedTaskIds: string[] = [];

          // ── Per-task session completion (one detection call per task) ──────
          for (const taskId of perTaskRemaining) {
            const info = taskTimeouts.get(taskId)!;
            const perSession = info.taskTmuxSession!;

            // File-based detection for tasks with runId.
            if (info.runId) {
              const doneResult = await readRunCompletion(agent.server, info.runId);

              if (doneResult.found && doneResult.data) {
                const { exitCode, finishedAt: finishedAtStr } = doneResult.data;
                const newStatus = exitCode === 0 ? "completed" : "failed";
                const perFinishedAt = new Date(finishedAtStr);
                const logTail = agentGroupDisablePaneCapture
                  ? null
                  : (await readLogTail(agent.server, info.runId, LOG_TAIL_LINES)) || null;
                const secretVals = logTail ? await taskSecretValues(taskId) : [];

                try {
                  await prisma.$transaction(async (tx) => {
                    const latestLog = await tx.executionLog.findFirst({
                      where: { taskId, status: "running", finishedAt: null },
                      orderBy: { createdAt: "desc" },
                      select: { id: true, startedAt: true },
                    });
                    await tx.task.update({ where: { id: taskId }, data: { status: newStatus } });
                    if (latestLog) {
                      await tx.executionLog.update({
                        where: { id: latestLog.id },
                        data: {
                          status: newStatus,
                          finishedAt: perFinishedAt,
                          durationMs: perFinishedAt.getTime() - latestLog.startedAt.getTime(),
                          exitReason: exitCode === 0 ? "done_file" : "done_file_nonzero",
                          paneCapture: logTail ? scrubPaneCapture(logTail, secretVals) : null,
                          errorMessage: exitCode !== 0 ? `Claude exited with code ${exitCode}` : null,
                          tokenCount: agentCostData.tokenCount,
                          actualCostUsd: agentCostData.actualCostUsd,
                        },
                      });
                    }
                  });
                  clearDispatchBackoff(taskId, backoff);
                  completedTaskIds.push(taskId);
                  console.log(`[TASK_FINISHED] taskId="${taskId}" agentId="${agentId}" detectedBy="done_file" exitCode=${exitCode}`);
                  emitAudit({ entityType: "task", entityId: taskId, eventType: `task.${newStatus}`, actorType: "poller", payload: { detectedBy: "done_file", exitCode, agentId } }).catch(() => {});
                  emitNotification(taskId, newStatus === "completed" ? "task.completed" : "task.failed").catch(() => {});
                  const projIdDone = agentTaskProjectId.get(taskId);
                  if (projIdDone) {
                    recalculateProjectProgress(projIdDone).catch(() => {});
                    if (newStatus === "completed") {
                      unblockDependents(taskId).catch(() => {});
                      prisma.project.findUnique({ where: { id: projIdDone }, select: { autoReviewEnabled: true } })
                        .then((proj) => {
                          if (!proj?.autoReviewEnabled) return;
                          return prisma.task.update({
                            where: { id: taskId },
                            data: { autoReviewEnabled: true, reviewStatus: "pending", reviewScheduledAt: new Date(Date.now() + 5 * 60_000) },
                          });
                        }).catch(() => {});
                    } else {
                      await evaluateRetry(taskId, "done_file_nonzero").catch((err) => {
                        console.error(`${TAG} Task ${taskId}: retry evaluation failed:`, err);
                      });
                    }
                  }
                  await killTaskTmuxSession(agent.server, taskId).catch(() => {});
                  await prisma.task.update({ where: { id: taskId }, data: { taskTmuxSession: null } }).catch(() => {});
                } catch (err) {
                  console.error(`${TAG} Task ${taskId}: failed to record done-file completion:`, err);
                }
                continue; // next perTask
              }

              // Done-file not ready — check if session still alive.
              const sessionAlive = await tmuxSessionExists(agent.server, perSession);
              if (!sessionAlive) {
                console.log(`${TAG} Agent ${agent.name}: task "${taskId}" — session gone, no done-file → needs_review`);
                try {
                  await prisma.$transaction(async (tx) => {
                    await tx.task.update({ where: { id: taskId }, data: { status: "needs_review" } });
                    const latestLog = await tx.executionLog.findFirst({
                      where: { taskId, status: "running", finishedAt: null },
                      orderBy: { createdAt: "desc" },
                      select: { id: true, startedAt: true },
                    });
                    if (latestLog) {
                      const now = new Date();
                      await tx.executionLog.update({
                        where: { id: latestLog.id },
                        data: {
                          status: "failed",
                          finishedAt: now,
                          durationMs: now.getTime() - latestLog.startedAt.getTime(),
                          exitReason: "needs_review",
                          errorMessage: "tmux session gone before done-file was written — needs manual review",
                        },
                      });
                    }
                  });
                  completedTaskIds.push(taskId); // so agent is released below
                  emitAudit({ entityType: "task", entityId: taskId, eventType: "task.needs_review", actorType: "poller", payload: { reason: "session_gone_no_done_file", agentId } }).catch(() => {});
                  emitNotification(taskId, "task.failed").catch(() => {});
                  const projIdNr = agentTaskProjectId.get(taskId);
                  if (projIdNr) recalculateProjectProgress(projIdNr).catch(() => {});
                } catch (err) {
                  console.error(`${TAG} Task ${taskId}: failed to mark needs_review:`, err);
                }
              }
              // Session alive, done-file not ready — still running.
              continue;
            }

            // ── Legacy per-task pane detection (no runId) ────────────────────
            const perResult = await detectTaskCompletion(
              agent.server,
              perSession,
              taskId,
              info.completionNonce ?? undefined,
              info.tmuxOutputOffset ?? undefined,
            );

            if (perResult.tmuxMissing) {
              console.log(
                `${TAG} Agent ${agent.name}: per-task session '${perSession}' not found — marking task completed`
              );
            }

            let perHow: string | null = null;
            if (perResult.markerFound) {
              perHow = "completion marker";
            } else if (perResult.tmuxMissing) {
              perHow = "session gone";
            } else if (perResult.isIdle && !info.completionNonce) {
              perHow = "idle prompt (no nonce)";
            } else if (perResult.isIdle) {
              const runMs = Date.now() - info.taskStartedAt.getTime();
              if (runMs >= IDLE_FALLBACK_MIN_MS) {
                perHow = `idle fallback (no marker after ${Math.round(runMs / 60_000)}m)`;
                console.log(
                  `${TAG} Agent ${agent.name}: task "${taskId}" idle without nonce marker — ` +
                  `using idle fallback after ${Math.round(runMs / 60_000)}m`
                );
              }
            }

            if (!perHow) continue;

            const perFinishedAt = new Date();
            const perPaneCapture = (!agentGroupDisablePaneCapture && perResult.paneText)
              ? scrubPaneCapture(lastNLines(perResult.paneText, 200), await taskSecretValues(taskId))
              : null;
            const perExitReason = completedHowToExitReason(perHow);

            try {
              const perGate = await applyValidationGate({
                taskId,
                projectId: agentTaskProjectId.get(taskId) ?? "",
                title: info.title,
                isAutonomous: info.isAutonomous,
                paneText: perResult.paneText,
                expectedNonce: info.completionNonce,
              });
              const perFinalStatus: "completed" | "failed" = perGate.allowed ? "completed" : "failed";
              const perFinalExitReason = perGate.allowed ? perExitReason : "validation_failed";

              await prisma.$transaction(async (tx) => {
                const latestLog = await tx.executionLog.findFirst({
                  where: { taskId, status: "running", finishedAt: null },
                  orderBy: { createdAt: "desc" },
                  select: { id: true, startedAt: true },
                });
                if (perGate.allowed) {
                  await tx.task.update({ where: { id: taskId }, data: { status: "completed" } });
                }
                if (latestLog) {
                  await tx.executionLog.update({
                    where: { id: latestLog.id },
                    data: {
                      status: perFinalStatus,
                      finishedAt: perFinishedAt,
                      durationMs: perFinishedAt.getTime() - latestLog.startedAt.getTime(),
                      exitReason: perFinalExitReason,
                      paneCapture: perPaneCapture,
                      tokenCount: agentCostData.tokenCount,
                      actualCostUsd: agentCostData.actualCostUsd,
                    },
                  });
                }
              });
              completedTaskIds.push(taskId); // releases the agent either way — the task is no longer running

              if (!perGate.allowed) {
                console.log(`[TASK_FINISHED] taskId="${taskId}" agentId="${agentId}" detectedBy="${perHow}" blockedByValidationGate="${perGate.validationStatus}"`);
                emitNotification(taskId, "task.failed").catch(() => {});
                const failedProjId = agentTaskProjectId.get(taskId);
                if (failedProjId) recalculateProjectProgress(failedProjId).catch(() => {});
                await killTaskTmuxSession(agent.server, taskId).catch(() => {});
                await prisma.task.update({ where: { id: taskId }, data: { taskTmuxSession: null } }).catch(() => {});
                continue;
              }

              clearDispatchBackoff(taskId, backoff);
              console.log(`[TASK_FINISHED] taskId="${taskId}" agentId="${agentId}" detectedBy="${perHow}"`);
              emitAudit({ entityType: "task", entityId: taskId, eventType: "task.completed", actorType: "poller", payload: { detectedBy: perHow, agentId } }).catch(() => {});
              emitNotification(taskId, "task.completed").catch(() => {});
              const projId = agentTaskProjectId.get(taskId);
              if (projId) {
                recalculateProjectProgress(projId).catch(() => {});
                prisma.project.findUnique({ where: { id: projId }, select: { autoReviewEnabled: true } })
                  .then((proj) => {
                    if (!proj?.autoReviewEnabled) return;
                    return prisma.task.update({
                      where: { id: taskId },
                      data: { autoReviewEnabled: true, reviewStatus: "pending", reviewScheduledAt: new Date(Date.now() + 5 * 60_000) },
                    });
                  }).catch(() => {});
              }
              unblockDependents(taskId).catch(() => {});
              await killTaskTmuxSession(agent.server, taskId).catch(() => {});
              await prisma.task.update({ where: { id: taskId }, data: { taskTmuxSession: null } }).catch(() => {});
            } catch (err) {
              console.error(`${TAG} Task ${taskId}: failed to mark agent task completed:`, err);
            }
          }

          // ── Legacy shared-session completion ───────────────────────────────
          if (legacyRemaining.length > 0) {
            const firstTaskId = legacyRemaining[0];
            const firstInfo = taskTimeouts.get(firstTaskId);

            const legacyResult = await detectTaskCompletion(
              agent.server,
              agent.tmuxSession,
              firstTaskId,
              firstInfo?.completionNonce ?? completionNonce ?? undefined,
              firstInfo?.tmuxOutputOffset ?? tmuxOutputOffset ?? undefined,
            );

            if (legacyResult.tmuxMissing) {
              offlineAgentIds.add(agentId);
              recordAgentOffline(agentId, agentOfflineStore);
              try {
                await prisma.agent.update({ where: { id: agentId }, data: { status: "offline" } });
              } catch { /* non-fatal */ }
              console.log(
                `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' not found during completion check — ` +
                `marking offline, skipping queue advance`
              );
              emitAudit({ entityType: "agent", entityId: agentId, eventType: "agent.offline", actorType: "poller", payload: { reason: "tmux_missing_completion_check", tmuxSession: agent.tmuxSession } }).catch(() => {});
              return;
            }

            let legacyHow: string | null = null;
            if (legacyResult.markerFound) {
              legacyHow = "completion marker";
            } else if (legacyResult.isIdle && !completionNonce) {
              legacyHow = "idle prompt (no nonce)";
            } else if (legacyResult.isIdle) {
              const runMs = Date.now() - startedAt.getTime();
              if (runMs >= IDLE_FALLBACK_MIN_MS) {
                legacyHow = `idle fallback (no marker after ${Math.round(runMs / 60_000)}m)`;
                console.log(
                  `${TAG} Agent ${agent.name}: task "${firstTaskId}" idle without nonce marker — ` +
                  `using idle fallback after ${Math.round(runMs / 60_000)}m`
                );
              }
            }

            if (legacyHow) {
              const legacyFinishedAt = new Date();
              const legacyPaneCapture = (!agentGroupDisablePaneCapture && legacyResult.paneText)
                ? scrubPaneCapture(lastNLines(legacyResult.paneText, 200), await multiTaskSecretValues(legacyRemaining))
                : null;
              const legacyExitReason = completedHowToExitReason(legacyHow);

              for (const taskId of legacyRemaining) {
                try {
                  const legacyInfo = taskTimeouts.get(taskId);
                  const legacyGate = await applyValidationGate({
                    taskId,
                    projectId: agentTaskProjectId.get(taskId) ?? "",
                    title: legacyInfo?.title ?? "",
                    isAutonomous: legacyInfo?.isAutonomous ?? false,
                    paneText: legacyResult.paneText,
                    expectedNonce: legacyInfo?.completionNonce ?? completionNonce,
                  });
                  const legacyFinalStatus: "completed" | "failed" = legacyGate.allowed ? "completed" : "failed";
                  const legacyFinalExitReason = legacyGate.allowed ? legacyExitReason : "validation_failed";

                  await prisma.$transaction(async (tx) => {
                    const latestLog = await tx.executionLog.findFirst({
                      where: { taskId, status: "running", finishedAt: null },
                      orderBy: { createdAt: "desc" },
                      select: { id: true, startedAt: true },
                    });
                    if (legacyGate.allowed) {
                      await tx.task.update({ where: { id: taskId }, data: { status: "completed" } });
                    }
                    if (latestLog) {
                      await tx.executionLog.update({
                        where: { id: latestLog.id },
                        data: {
                          status: legacyFinalStatus,
                          finishedAt: legacyFinishedAt,
                          durationMs: legacyFinishedAt.getTime() - latestLog.startedAt.getTime(),
                          exitReason: legacyFinalExitReason,
                          paneCapture: legacyPaneCapture,
                          tokenCount: agentCostData.tokenCount,
                          actualCostUsd: agentCostData.actualCostUsd,
                        },
                      });
                    }
                  });
                  completedTaskIds.push(taskId); // releases the agent either way

                  if (!legacyGate.allowed) {
                    console.log(`[TASK_FINISHED] taskId="${taskId}" agentId="${agentId}" detectedBy="${legacyHow}" blockedByValidationGate="${legacyGate.validationStatus}"`);
                    emitNotification(taskId, "task.failed").catch(() => {});
                    const failedProjId = agentTaskProjectId.get(taskId);
                    if (failedProjId) recalculateProjectProgress(failedProjId).catch(() => {});
                    continue;
                  }

                  clearDispatchBackoff(taskId, backoff);
                  console.log(`[TASK_FINISHED] taskId="${taskId}" agentId="${agentId}" detectedBy="${legacyHow}"`);
                  emitAudit({ entityType: "task", entityId: taskId, eventType: "task.completed", actorType: "poller", payload: { detectedBy: legacyHow, agentId } }).catch(() => {});
                  emitNotification(taskId, "task.completed").catch(() => {});
                  const projId = agentTaskProjectId.get(taskId);
                  if (projId) {
                    recalculateProjectProgress(projId).catch(() => {});
                    prisma.project.findUnique({ where: { id: projId }, select: { autoReviewEnabled: true } })
                      .then((proj) => {
                        if (!proj?.autoReviewEnabled) return;
                        return prisma.task.update({
                          where: { id: taskId },
                          data: { autoReviewEnabled: true, reviewStatus: "pending", reviewScheduledAt: new Date(Date.now() + 5 * 60_000) },
                        });
                      }).catch(() => {});
                  }
                  unblockDependents(taskId).catch(() => {});
                } catch (err) {
                  console.error(`${TAG} Task ${taskId}: failed to mark agent task completed:`, err);
                }
              }
            }
          }

          if (completedTaskIds.length === 0) return;
        }

        // Release agent if no tasks remain running; set 30 s cooldown before re-dispatch.
        const nowRunningCount = await prisma.task.count({ where: { agentId, status: "running" } });
        let cooldownActive = false;
        if (nowRunningCount === 0) {
          try {
            await prisma.agent.update({
              where: { id: agentId },
              data: { status: "idle", cooldownUntil: new Date(Date.now() + AGENT_COOLDOWN_MS), activeTaskCount: 0 },
            });
            console.log(`[AGENT_RELEASED] agentId="${agentId}" name="${agent.name}" cooldown=${AGENT_COOLDOWN_MS / 1000}s`);
            cooldownActive = true;
          } catch (err) {
            console.error(`${TAG} Agent ${agent.name}: failed to set idle:`, err);
          }
        } else {
          // Re-sync the cached counter (e.g. one of several concurrent tasks finished/failed
          // while others kept running) so lib/agent-selector.ts always sees an accurate count.
          await prisma.agent.update({ where: { id: agentId }, data: { activeTaskCount: nowRunningCount } }).catch(() => {});
        }

        // Auto-advance: fill up to maxConcurrentTasks after completions.
        const sessionPct = agent.claudeSessionPct ?? 0;
        const weekPct = agent.claudeWeekPct ?? 0;

        if (cooldownActive) return; // 30 s cooldown — next cycle will dispatch if needed

        if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
          console.log(
            `${TAG} Agent ${agent.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping queue advance`
          );
          return;
        }

        const maxConcurrent = agent.maxConcurrentTasks ?? 1;
        let stillRunning = nowRunningCount;
        while (stillRunning < maxConcurrent) {
          const nextTask = await prisma.task.findFirst({
            where: {
              agentId,
              status: "queued",
              blockedByCount: 0,
              OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
            },
            orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
            select: {
              id: true, title: true, description: true, priority: true,
              requiredTags: true,
              retryAfter: true, blockedByCount: true,
              project: { select: { name: true } },
            },
          });

          if (!nextTask) break;

          // Skip tasks whose required capability tags are not met by this agent.
          const agentTags = new Set((agent as { tags?: string[] }).tags ?? []);
          if (nextTask.requiredTags.some((t) => !agentTags.has(t))) {
            console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): skipped — agent missing required tags [${nextTask.requiredTags.filter((t) => !agentTags.has(t)).join(", ")}]`);
            break;
          }

          if (shouldSkipDueToBackoff(nextTask.id, backoff)) {
            console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): skipped — backoff in effect`);
            break;
          }

          const outcome = await tryDispatchTaskToAgent({
            taskId: nextTask.id,
            agentId,
            sshConfig: agent.server,
            tmuxSession: agent.tmuxSession,
            workDir: agent.workDir,
            permissionMode: agent.claudePermissionMode as import("@/lib/ssh-claude-tmux").ClaudePermissionMode,
            maxConcurrentTasks: maxConcurrent,
            task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
            logText: `Auto-started from queue on agent "${agent.name}" — mode: ${agent.claudePermissionMode}`,
            usageSnapshotPct: agent.claudeSessionPct,
          });

          if (outcome.ok) {
            clearDispatchBackoff(nextTask.id, backoff);
            stillRunning++;
            console.log(`[NEXT_TASK_DISPATCHED] taskId="${nextTask.id}" title="${nextTask.title}" agentId="${agentId}"`);
          } else if (outcome.reason === "ssh_failed") {
            recordDispatchFailure(nextTask.id, backoff);
            console.warn(`${TAG} Agent ${agent.name}: queue advance failed for task ${nextTask.id}: ${outcome.detail} — backoff applied`);
            break;
          } else if (outcome.reason === "tmux_missing") {
            offlineAgentIds.add(agentId);
            recordAgentOffline(agentId, agentOfflineStore);
            console.warn(`${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' missing during dispatch — marked offline`);
            break;
          } else {
            break;
          }
        }
      })
    ).then((results) => {
      [...byAgent.values()].forEach(({ agent }, i) => {
        if (results[i].status === "rejected")
          console.error(`${TAG} Agent completion check for ${agent.name} threw:`, results[i].reason);
      });
    });

    // ── 2b-ext. Cron-scheduled tasks — spawn new pending Tasks from due ScheduledTask records ──
    try {
      await runDueScheduledTasks();
    } catch (err) {
      console.error(`${TAG} runDueScheduledTasks threw:`, err);
    }

    // ── 2c. Scheduled task dispatch — auto-queue pending tasks whose scheduledFor has passed ──
    try {
      const now = new Date();
      const dueTasks = await prisma.task.findMany({
        where: { status: "pending", scheduledFor: { lte: now } },
        select: { id: true, title: true, projectId: true },
      });
      for (const t of dueTasks) {
        await prisma.task.update({ where: { id: t.id }, data: { status: "queued", scheduledFor: null } });
        emitAudit({
          entityType: "task",
          entityId: t.id,
          eventType: "task.queued",
          actorType: "system",
          payload: { reason: "scheduled_dispatch" },
        }).catch(() => {});
        console.log(`${TAG} Scheduled dispatch: queued task ${t.id} (${t.title})`);
      }
    } catch (err) {
      console.error(`${TAG} scheduled task dispatch threw:`, err);
    }

    // ── 2c-ext2. Autonomous agent selection — assign + dispatch unassigned pending tasks ──
    // Only acts on projects with autonomousMode >= 3; see lib/agent-selector.ts and
    // lib/task-service.ts's autoAssignQueuedTasks for the scoring/risk-gating rules.
    try {
      const { assigned, skipped } = await autoAssignQueuedTasks();
      if (assigned > 0 || skipped > 0) {
        console.log(`${TAG} Autonomous agent selection: assigned=${assigned} skipped=${skipped}`);
      }
    } catch (err) {
      console.error(`${TAG} autoAssignQueuedTasks threw:`, err);
    }

    // ── 2d. Stuck-task reconciliation — running tasks with runId but no session/done-file ──
    // Guards against tasks that were mid-run when the server restarted (no session, no
    // done-file because the wrapper never exited cleanly). Only checks tasks that have
    // been "running" for > 10 minutes to avoid false positives on newly dispatched tasks.
    try {
      const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
      const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
      const potentiallyStuck = await prisma.task.findMany({
        where: { status: "running", runId: { not: null }, updatedAt: { lte: stuckCutoff } },
        select: {
          id: true,
          runId: true,
          taskTmuxSession: true,
          agent: {
            select: {
              server: { select: { host: true, port: true, username: true, sshKeyPath: true } },
            },
          },
          server: { select: { host: true, port: true, username: true, sshKeyPath: true } },
        },
      });

      for (const stuckTask of potentiallyStuck) {
        const sshCfg = stuckTask.agent?.server ?? stuckTask.server;
        if (!sshCfg || !stuckTask.runId) continue;

        const doneResult = await readRunCompletion(sshCfg, stuckTask.runId);
        if (doneResult.found) continue; // completion handler will pick it up on next cycle

        const sessionName = stuckTask.taskTmuxSession ?? `claude_${stuckTask.id}`;
        const alive = await tmuxSessionExists(sshCfg, sessionName);
        if (alive) continue; // still running normally

        console.log(`${TAG} Stuck-task reconciliation: task "${stuckTask.id}" — no session, no done-file → needs_review`);
        try {
          await prisma.$transaction(async (tx) => {
            await tx.task.update({ where: { id: stuckTask.id }, data: { status: "needs_review" } });
            const latestLog = await tx.executionLog.findFirst({
              where: { taskId: stuckTask.id, status: "running", finishedAt: null },
              orderBy: { createdAt: "desc" },
              select: { id: true, startedAt: true },
            });
            if (latestLog) {
              const reconcileNow = new Date();
              await tx.executionLog.update({
                where: { id: latestLog.id },
                data: {
                  status: "failed",
                  finishedAt: reconcileNow,
                  durationMs: reconcileNow.getTime() - latestLog.startedAt.getTime(),
                  exitReason: "needs_review",
                  errorMessage: "stuck-task reconciliation: session gone, no done-file — needs manual review",
                },
              });
            }
          });
          emitAudit({
            entityType: "task",
            entityId: stuckTask.id,
            eventType: "task.needs_review",
            actorType: "poller",
            payload: { reason: "stuck_task_reconciliation" },
          }).catch(() => {});
          emitNotification(stuckTask.id, "task.failed").catch(() => {});
        } catch (err) {
          console.error(`${TAG} Stuck-task reconciliation: failed to mark task ${stuckTask.id}:`, err);
        }
      }
    } catch (err) {
      console.error(`${TAG} Stuck-task reconciliation threw:`, err);
    }

    // ── 2e. Stale-running agent reconciliation ────────────────────────────────
    // When Claude self-reports task completion directly to the DB (via the psql
    // finalization command in the dispatch prompt), the poller's pane scanner won't
    // see a WORKERAI_RESULT block and won't release the agent.  This step detects
    // agents whose DB status is "running" but have no running tasks, and resets
    // them to idle with the standard cooldown so the next queued task can proceed.
    try {
      const staleRunningAgents = await prisma.agent.findMany({
        where: {
          status: "running",
          tasks: { none: { status: "running" } },
        },
        select: { id: true, name: true },
      });
      for (const agent of staleRunningAgents) {
        await prisma.agent.update({
          where: { id: agent.id },
          data: {
            status: "idle",
            cooldownUntil: new Date(Date.now() + AGENT_COOLDOWN_MS),
          },
        });
        console.log(
          `${TAG} Agent ${agent.name}: self-completed task detected — set idle + ${AGENT_COOLDOWN_MS / 1000}s cooldown`,
        );
      }
    } catch (err) {
      console.error(`${TAG} Stale-running agent reconciliation threw:`, err);
    }

    // ── 2f. Stale-pending alert ───────────────────────────────────────────────
    // Alert when a task has been in pending status longer than the configured
    // threshold without being dispatched. Deduplication: alert fires at most
    // once per hour per task (lastStalePendingAlertAt gate).
    try {
      const thresholdRow = await prisma.systemConfig.findUnique({
        where: { key: "stale_pending_alert_minutes" },
        select: { value: true },
      });
      const thresholdMinutes = Math.max(1, parseInt(thresholdRow?.value ?? "60", 10) || 60);
      const thresholdMs = thresholdMinutes * 60_000;
      const dedupeMs    = 60 * 60_000; // re-alert at most once per hour

      const staleCutoff  = new Date(Date.now() - thresholdMs);
      const dedupeCutoff = new Date(Date.now() - dedupeMs);

      const stalePending = await prisma.task.findMany({
        where: {
          status: "pending",
          createdAt: { lte: staleCutoff },
          OR: [
            { lastStalePendingAlertAt: null },
            { lastStalePendingAlertAt: { lte: dedupeCutoff } },
          ],
        },
        select: {
          id: true,
          title: true,
          projectId: true,
          createdAt: true,
          project: { select: { name: true } },
        },
      });

      for (const t of stalePending) {
        const pendingMinutes = Math.round((Date.now() - t.createdAt.getTime()) / 60_000);
        console.log(`${TAG} Stale-pending alert: task "${t.id}" (${t.title}) pending ${pendingMinutes}m`);
        await prisma.task.update({
          where: { id: t.id },
          data: { lastStalePendingAlertAt: new Date() },
        });
        emitStalePendingNotification({
          taskId: t.id,
          title: t.title,
          projectId: t.projectId,
          projectName: t.project?.name ?? null,
          pendingMinutes,
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`${TAG} Stale-pending alert threw:`, err);
    }

    // ── 3. Start queued server-direct tasks on servers with capacity ─────────
    // Dispatch any queued task into the server's long-lived Claude tmux session
    // as long as the server's usage is under threshold.
    // Servers confirmed offline this cycle are skipped.
    let serversWithQueue: {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      sshKeyPath: string;
      tmuxSession: string;
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
          tmuxSession: true,
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
          tmuxSession: srv.tmuxSession,
          permissionMode: srv.claudePermissionMode as ClaudePermissionMode,
          task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
          logText: `Auto-started from queue on server "${srv.name}" (${srv.host}) — mode: ${srv.claudePermissionMode}`,
          usageSnapshotPct: srv.claudeSessionPct,
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
      workDir: string;
      claudePermissionMode: string;
      claudeSessionPct: number | null;
      claudeWeekPct: number | null;
      claudeSessionResetsAt: Date | null;
      claudeWeekResetsAt: Date | null;
      autoPauseEnabled: boolean;
      pausedDueToUsage: boolean;
      maxConcurrentTasks: number;
      cooldownUntil: Date | null;
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
          AND: [
            { tasks: { none: { status: "running" } } },
            // Skip agents still within their post-completion cooldown window.
            { OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: new Date() } }] },
          ],
          // Skip agents already handled by the completion loop above,
          // and agents confirmed offline this cycle.
          NOT: { id: { in: [...byAgent.keys(), ...offlineAgentIds] } },
        },
        select: {
          id: true,
          name: true,
          tmuxSession: true,
          workDir: true,
          claudePermissionMode: true,
          claudeSessionPct: true,
          claudeWeekPct: true,
          claudeSessionResetsAt: true,
          claudeWeekResetsAt: true,
          autoPauseEnabled: true,
          pausedDueToUsage: true,
          maxConcurrentTasks: true,
          tags: true,
          cooldownUntil: true,
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

        const agentMax = agent.maxConcurrentTasks ?? 1;
        let dispatched = 0;
        while (dispatched < agentMax) {
          const nextTask = await prisma.task.findFirst({
            where: {
              agentId: agent.id,
              status: "queued",
              OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
            },
            orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
            select: {
              id: true, title: true, description: true, priority: true,
              requiredTags: true,
              retryAfter: true, blockedByCount: true,
              project: { select: { name: true } },
            },
          });

          if (!nextTask) break;

          // Skip tasks whose required capability tags are not met by this agent.
          const agentTagSet = new Set((agent as { tags?: string[] }).tags ?? []);
          if (nextTask.requiredTags.some((t) => !agentTagSet.has(t))) {
            console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): skipped — agent missing required tags [${nextTask.requiredTags.filter((t) => !agentTagSet.has(t)).join(", ")}]`);
            break;
          }

          if (shouldSkipDueToBackoff(nextTask.id, backoff)) {
            console.log(
              `${TAG} Task ${nextTask.id} ("${nextTask.title}"): skipped — backoff in effect`
            );
            break;
          }

          const outcome = await tryDispatchTaskToAgent({
            taskId: nextTask.id,
            agentId: agent.id,
            sshConfig: agent.server,
            tmuxSession: agent.tmuxSession,
            workDir: agent.workDir,
            permissionMode: agent.claudePermissionMode as import("@/lib/ssh-claude-tmux").ClaudePermissionMode,
            maxConcurrentTasks: agentMax,
            task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
            logText: `Auto-started from queue on agent "${agent.name}" — mode: ${agent.claudePermissionMode}`,
            usageSnapshotPct: agent.claudeSessionPct,
          });

          if (outcome.ok) {
            clearDispatchBackoff(nextTask.id, backoff);
            dispatched++;
            console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): dispatched from idle-agent queue (${dispatched}/${agentMax})`);
          } else if (outcome.reason === "ssh_failed") {
            recordDispatchFailure(nextTask.id, backoff);
            console.warn(
              `${TAG} Agent ${agent.name}: failed to start queued task ${nextTask.id}: ${outcome.detail} — backoff applied`
            );
            break;
          } else if (outcome.reason === "tmux_missing") {
            offlineAgentIds.add(agent.id);
            recordAgentOffline(agent.id, agentOfflineStore);
            console.warn(
              `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' missing during dispatch — marked offline`
            );
            break;
          } else {
            break;
          }
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

      // ── 6b. Orphaned per-task session cleanup ──────────────────────────────
      // Per-task tmux sessions (claude_<taskId>) must be killed when their task
      // reaches a terminal state.  Several failure modes leave them alive:
      //   • killTaskTmuxSession SSH error (.catch swallowed, no retry)
      //   • Manual PUT /status transition — that route has no SSH config and
      //     never calls killTaskTmuxSession
      //   • Poller crash between the DB write and the kill call
      //
      // This sweep finds every terminal task with taskTmuxSession still set,
      // kills the session idempotently (tmux kill-session ... || true), then
      // clears the DB field so the task won't appear again next sweep.
      //
      // Long-lived agent sessions (claude-agent-1, etc.) use a hyphen separator
      // and are never recorded in taskTmuxSession, so they are never touched here.
      try {
        const orphanedSessions = await prisma.task.findMany({
          where: {
            taskTmuxSession: { not: null },
            status: { in: ["completed", "failed", "needs_review", "archived"] },
          },
          select: {
            id: true,
            status: true,
            taskTmuxSession: true,
            server: { select: { host: true, port: true, username: true, sshKeyPath: true } },
            agent: { select: { server: { select: { host: true, port: true, username: true, sshKeyPath: true } } } },
          },
          take: 100,
        });

        if (orphanedSessions.length > 0) {
          console.log(`${TAG} Orphaned session cleanup: ${orphanedSessions.length} terminal task(s) still have taskTmuxSession set`);
          for (const t of orphanedSessions) {
            const sshCfg = t.server ?? t.agent?.server ?? null;
            if (sshCfg) {
              await killTaskTmuxSession(sshCfg, t.id).catch(() => {});
            }
            // Clear the field so this task won't re-appear in future sweeps.
            // If this update fails the sweep will simply retry the kill next cycle
            // (killTaskTmuxSession is idempotent — tmux kill-session ... || true).
            await prisma.task.update({
              where: { id: t.id },
              data: { taskTmuxSession: null },
            }).catch((err) => {
              console.error(`${TAG} Orphaned session cleanup: failed to clear taskTmuxSession for task ${t.id}:`, err);
            });
            console.log(`${TAG} Orphaned session cleanup: killed session for task "${t.id}" (${t.status})`);
          }
        }
      } catch (err) {
        console.error(`${TAG} Orphaned session cleanup threw:`, err);
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

    // ── 8. Nightly log archival + table pruning (1 AM UTC, once per day) ────
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
      try {
        await pruneHighVolumeTables();
      } catch (err) {
        console.error(`${TAG} Nightly table pruning threw:`, err);
      }
    }

    // ── 9. Auto daily report (1 AM UTC, once per day) ────────────────────────
    await runDailyReportIfNeeded();

    // ── 10. Weekly analytics (Monday 1 AM UTC, once per week) ────────────────
    await runWeeklyAnalyticsIfNeeded();

    // ── 10a. Weekly report (Monday 2 AM UTC, once per week) ──────────────────
    await runWeeklyReportIfNeeded();

    // ── 10b. Monthly report (1st of month 3 AM UTC, once per month) ──────────
    await runMonthlyReportIfNeeded();

    // ── 11. Auto-review queue (every cycle, max 3 reviews) ───────────────────
    try {
      await processReviewQueue(3);
    } catch (err) {
      console.error(`${TAG} processReviewQueue threw:`, err);
    }

    // ── 12. Project improvement scans (daily at 2 AM UTC, frequency-gated) ───
    await runProjectScansIfNeeded();

    // ── 12b. Objective-driven improvement review (daily at 4 AM UTC, autonomousMode >= 1) ──
    await runImprovementReviewsIfNeeded();

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

    // ── 14. Self-healing cycle — detect incidents, run auto-repairs ──────────
    try {
      await runSelfHealingCycle();
    } catch (err) {
      console.error(`${TAG} runSelfHealingCycle threw:`, err);
    }

    // Persist heartbeat so the health endpoint can detect a stalled poller.
    try {
      const heartbeat = new Date().toISOString();
      await prisma.systemConfig.upsert({
        where: { key: "poller_last_heartbeat_at" },
        create: { key: "poller_last_heartbeat_at", value: heartbeat },
        update: { value: heartbeat },
      });
    } catch (err) {
      console.error(`${TAG} Failed to write poller heartbeat:`, err);
    }

    console.log(`${TAG} poll end`);
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────
  // Use globalThis so the running flag survives Next.js HMR module re-evaluation.

  async function tick() {
    if (g._shutdownRequested) {
      console.log(`${TAG} Shutdown requested — skipping poll tick`);
      return;
    }
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

  // ── Graceful shutdown on SIGTERM ────────────────────────────────────────────
  // Prevents mid-cycle DB writes (partial task status, orphaned ExecutionLog
  // records) when Docker/k8s stops the process.
  process.on("SIGTERM", async () => {
    g._shutdownRequested = true;
    if (g._pollerRunning) {
      console.log(`${TAG} Poller: SIGTERM received, waiting for current cycle to finish...`);
      const deadline = Date.now() + 30_000;
      while (g._pollerRunning && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    } else {
      console.log(`${TAG} Poller: SIGTERM received, no cycle in progress`);
    }
    console.log(`${TAG} Poller: shutdown complete`);
    process.exit(0);
  });

  // First check 15 s after server start (DB pool warm-up), then every 60 s.
  setTimeout(() => tick(), 15_000);
  setInterval(() => tick(), 60_000);

  console.log(
    `${TAG} Background poller registered (first check in 15 s, then every 60 s)`
  );
}
