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
} from "./lib/ssh-claude-tmux";
import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "./lib/task-dispatch";
import { USAGE_THRESHOLD } from "./lib/constants";
import {
  shouldSkipDueToBackoff,
  recordDispatchFailure,
  clearDispatchBackoff,
  shouldSkipAgentOffline,
  recordAgentOffline,
  clearAgentOffline,
  type BackoffEntry,
} from "./lib/dispatch-backoff";

const TAG = "[usage-poller]";

// Preserve state across Next.js HMR module re-evaluations.
const g = globalThis as unknown as {
  _usagePollerStarted?: boolean;
  _pollerRunning?: boolean;
  _dispatchBackoff?: Map<string, BackoffEntry>;
  _agentOfflineStore?: Map<string, number>;
};

if (!g._usagePollerStarted) {
  g._usagePollerStarted = true;
  if (!g._dispatchBackoff) g._dispatchBackoff = new Map();
  if (!g._agentOfflineStore) g._agentOfflineStore = new Map();
  startPoller();
}

function startPoller() {
  // ── Core polling logic ──────────────────────────────────────────────────────

  async function runCheck() {
    const ts = new Date().toISOString();
    console.log(`${TAG} ${ts} — poll start`);

    const backoff = g._dispatchBackoff!;
    const agentOfflineStore = g._agentOfflineStore!;

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
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load servers:`, err);
    }

    await Promise.allSettled(
      servers.map(async (srv) => {
        const result = await fetchClaudeUsageViaTmux({
          host: srv.host,
          port: srv.port,
          username: srv.username,
          sshKeyPath: srv.sshKeyPath,
        }, srv.tmuxSession);

        if (result.success) {
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
            },
          });
          console.log(
            `${TAG} ${srv.name}: session=${result.parsed.sessionPct ?? "?"}% ` +
              `week=${result.parsed.weekPct ?? "?"}%`
          );
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

        const result = await fetchClaudeUsageViaTmux(agent.server, agent.tmuxSession);

        if (result.success) {
          clearAgentOffline(agent.id, agentOfflineStore);
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
            },
          });
          console.log(
            `${TAG} Agent ${agent.name}: session=${result.parsed.sessionPct ?? "?"}% ` +
              `week=${result.parsed.weekPct ?? "?"}%`
          );
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

    // ── 2. Detect completion + auto-advance queue (server-direct tasks) ────────
    // Only tasks with agentId: null — agent tasks are handled in step 2b.
    let runningTasks: {
      id: string;
      serverId: string | null;
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
      } | null;
    }[] = [];

    try {
      runningTasks = await prisma.task.findMany({
        where: { status: "running", agentId: null },
        select: {
          id: true,
          serverId: true,
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
            },
          },
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load running tasks:`, err);
    }

    // Group by server — one SSH connection per server.
    type ServerInfo = (typeof runningTasks)[number]["server"] & {};
    const byServer = new Map<
      string,
      { server: NonNullable<ServerInfo>; taskIds: string[] }
    >();

    for (const task of runningTasks) {
      if (!task.serverId || !task.server) continue;
      const entry = byServer.get(task.serverId);
      if (entry) {
        entry.taskIds.push(task.id);
      } else {
        byServer.set(task.serverId, {
          server: task.server,
          taskIds: [task.id],
        });
      }
    }

    await Promise.allSettled(
      [...byServer.entries()].map(async ([serverId, { server: srv, taskIds }]) => {
        if (offlineServerIds.has(serverId)) {
          console.log(
            `${TAG} ${srv.name}: skipping idle check — server offline (tmux session missing)`
          );
          return;
        }

        const idleResult = await detectClaudeIdle({
          host: srv.host,
          port: srv.port,
          username: srv.username,
          sshKeyPath: srv.sshKeyPath,
        }, srv.tmuxSession);

        if (idleResult.tmuxMissing) {
          offlineServerIds.add(serverId);
          try {
            await prisma.server.update({
              where: { id: serverId },
              data: { status: "failed" },
            });
          } catch { /* non-fatal */ }
          console.log(
            `${TAG} ${srv.name}: tmux session '${srv.tmuxSession}' not found during idle check — ` +
            `marking offline, skipping queue advance`
          );
          return;
        }

        if (!idleResult.isIdle) return;

        for (const taskId of taskIds) {
          try {
            await prisma.$transaction(async (tx) => {
              const latestLog = await tx.executionLog.findFirst({
                where: { taskId, status: "running", finishedAt: null },
                orderBy: { createdAt: "desc" },
              });

              await tx.task.update({
                where: { id: taskId },
                data: { status: "completed" },
              });

              if (latestLog) {
                await tx.executionLog.update({
                  where: { id: latestLog.id },
                  data: { status: "completed", finishedAt: new Date() },
                });
              }
            });

            clearDispatchBackoff(taskId, backoff);
            console.log(
              `${TAG} Task ${taskId}: detected completion → marked completed`
            );
          } catch (err) {
            console.error(`${TAG} Task ${taskId}: failed to mark completed:`, err);
          }
        }

        const sessionPct = srv.claudeSessionPct ?? 0;
        const weekPct = srv.claudeWeekPct ?? 0;

        if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
          console.log(
            `${TAG} ${srv.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping queue advance`
          );
          return;
        }

        const nextTask = await prisma.task.findFirst({
          where: { serverId, status: "queued", agentId: null },
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

        const outcome = await tryDispatchTaskToServer({
          taskId: nextTask.id,
          serverId,
          sshConfig: { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath },
          tmuxSession: srv.tmuxSession,
          task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
          logText:
            `Auto-started from queue on server "${srv.name}" (${srv.host})` +
            (srv.claudePermissionMode ? ` — mode: ${srv.claudePermissionMode}` : ""),
        });

        if (outcome.ok) {
          clearDispatchBackoff(nextTask.id, backoff);
          console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): auto-started from queue`);
        } else if (outcome.reason === "ssh_failed") {
          recordDispatchFailure(nextTask.id, backoff);
          console.warn(
            `${TAG} Queue advance failed for task ${nextTask.id}: ${outcome.detail} — backoff applied`
          );
        } else if (outcome.reason === "tmux_missing") {
          offlineServerIds.add(serverId);
          console.warn(
            `${TAG} ${srv.name}: tmux session missing during dispatch — marked offline`
          );
        }
      })
    ).then((results) => {
      [...byServer.values()].forEach(({ server: srv }, i) => {
        if (results[i].status === "rejected")
          console.error(`${TAG} Completion check for server ${srv.host} threw:`, results[i].reason);
      });
    });

    // ── 2b. Detect completion + auto-advance queue (agent tasks) ─────────────
    let runningAgentTasks: {
      id: string;
      agentId: string | null;
      agent: {
        id: string;
        name: string;
        tmuxSession: string;
        claudePermissionMode: string;
        claudeSessionPct: number | null;
        claudeWeekPct: number | null;
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
          agentId: true,
          agent: {
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
          },
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load running agent tasks:`, err);
    }

    type AgentInfo = NonNullable<(typeof runningAgentTasks)[number]["agent"]>;
    const byAgent = new Map<string, { agent: AgentInfo; taskIds: string[] }>();

    for (const task of runningAgentTasks) {
      if (!task.agentId || !task.agent) continue;
      const entry = byAgent.get(task.agentId);
      if (entry) {
        entry.taskIds.push(task.id);
      } else {
        byAgent.set(task.agentId, { agent: task.agent, taskIds: [task.id] });
      }
    }

    await Promise.allSettled(
      [...byAgent.entries()].map(async ([agentId, { agent, taskIds }]) => {
        if (offlineAgentIds.has(agentId)) {
          console.log(
            `${TAG} Agent ${agent.name}: skipping idle check — offline (tmux session missing)`
          );
          return;
        }

        const idleResult = await detectClaudeIdle(agent.server, agent.tmuxSession);

        if (idleResult.tmuxMissing) {
          offlineAgentIds.add(agentId);
          recordAgentOffline(agentId, agentOfflineStore);
          try {
            await prisma.agent.update({
              where: { id: agentId },
              data: { status: "offline" },
            });
          } catch { /* non-fatal */ }
          console.log(
            `${TAG} Agent ${agent.name}: tmux session '${agent.tmuxSession}' not found during idle check — ` +
            `marking offline, skipping queue advance`
          );
          return;
        }

        if (!idleResult.isIdle) return;

        for (const taskId of taskIds) {
          try {
            await prisma.$transaction(async (tx) => {
              const latestLog = await tx.executionLog.findFirst({
                where: { taskId, status: "running", finishedAt: null },
                orderBy: { createdAt: "desc" },
              });

              await tx.task.update({
                where: { id: taskId },
                data: { status: "completed" },
              });

              if (latestLog) {
                await tx.executionLog.update({
                  where: { id: latestLog.id },
                  data: { status: "completed", finishedAt: new Date() },
                });
              }
            });

            clearDispatchBackoff(taskId, backoff);
            console.log(
              `${TAG} Task ${taskId}: agent-task completion detected → marked completed`
            );
          } catch (err) {
            console.error(`${TAG} Task ${taskId}: failed to mark agent task completed:`, err);
          }
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
          where: { agentId, status: "queued" },
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
          console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): auto-started from agent queue`);
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

    // ── 3. Start queued server-direct tasks on idle servers with no running tasks
    // Catches servers that are idle but have queued tasks (agentId: null only).
    let idleServersWithQueue: {
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
    }[] = [];

    try {
      idleServersWithQueue = await prisma.server.findMany({
        where: {
          tasks: { some: { status: "queued", agentId: null } },
          AND: { tasks: { none: { status: "running", agentId: null } } },
          NOT: {
            id: { in: [...byServer.keys(), ...offlineServerIds] },
          },
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
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load queued-only servers:`, err);
    }

    await Promise.allSettled(
      idleServersWithQueue.map(async (srv) => {
        const sessionPct = srv.claudeSessionPct ?? 0;
        const weekPct = srv.claudeWeekPct ?? 0;

        if (sessionPct >= USAGE_THRESHOLD || weekPct >= USAGE_THRESHOLD) {
          console.log(
            `${TAG} ${srv.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping`
          );
          return;
        }

        const idleResult = await detectClaudeIdle({
          host: srv.host,
          port: srv.port,
          username: srv.username,
          sshKeyPath: srv.sshKeyPath,
        }, srv.tmuxSession);

        if (idleResult.tmuxMissing) {
          offlineServerIds.add(srv.id);
          try {
            await prisma.server.update({
              where: { id: srv.id },
              data: { status: "failed" },
            });
          } catch { /* non-fatal */ }
          console.log(
            `${TAG} ${srv.name}: tmux session '${srv.tmuxSession}' not found — marked offline, skipping queued task`
          );
          return;
        }

        if (!idleResult.isIdle) {
          console.log(
            `${TAG} ${srv.name}: has queued tasks but Claude is not idle yet` +
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
          where: { serverId: srv.id, status: "queued", agentId: null },
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

        const outcome = await tryDispatchTaskToServer({
          taskId: nextTask.id,
          serverId: srv.id,
          sshConfig: { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath },
          tmuxSession: srv.tmuxSession,
          task: { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name },
          logText: `Auto-started from queue on server "${srv.name}" (${srv.host}) — mode: ${srv.claudePermissionMode}`,
        });

        if (outcome.ok) {
          clearDispatchBackoff(nextTask.id, backoff);
          console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): dispatched from idle-server queue`);
        } else if (outcome.reason === "ssh_failed") {
          recordDispatchFailure(nextTask.id, backoff);
          console.warn(
            `${TAG} ${srv.name}: failed to start queued task ${nextTask.id}: ${outcome.detail} — backoff applied`
          );
        } else if (outcome.reason === "tmux_missing") {
          offlineServerIds.add(srv.id);
          console.warn(
            `${TAG} ${srv.name}: tmux session '${srv.tmuxSession}' missing during dispatch — marked offline`
          );
        }
      })
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected")
          console.error(
            `${TAG} Idle-server queue check for ${idleServersWithQueue[i].host} threw:`,
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
          console.log(
            `${TAG} Agent ${agent.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping`
          );
          return;
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
          where: { agentId: agent.id, status: "queued" },
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
