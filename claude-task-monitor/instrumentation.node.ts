/**
 * Node.js-only instrumentation — imported by instrumentation.ts when
 * NEXT_RUNTIME === "nodejs". Module-level code runs on import, which is
 * how Next.js triggers it (no register() call needed).
 *
 * Background poller fires every 60 seconds:
 *   1. Fetches Claude CLI usage for every server via tmux and persists to DB.
 *   2. Checks running tasks for Claude idle state; marks completed + closes log.
 *   3. Auto-advances the queue: sends the next queued task on any now-idle server.
 */

import { prisma } from "./lib/prisma";
import {
  fetchClaudeUsageViaTmux,
  detectClaudeIdle,
  sendTaskToTmux,
} from "./lib/ssh-claude-tmux";

const TAG = "[usage-poller]";

// Prevent a second interval when Turbopack reloads the module (dev hot-reload).
const g = globalThis as unknown as { _usagePollerStarted?: boolean };
if (!g._usagePollerStarted) {
  g._usagePollerStarted = true;
  startPoller();
}

function startPoller() {
  // ── Core polling logic ──────────────────────────────────────────────────────

  async function runCheck() {
    const ts = new Date().toISOString();
    console.log(`${TAG} ${ts} — starting usage + completion check`);

    // ── 1. Refresh Claude usage for every server ────────────────────────────
    let servers: {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      sshKeyPath: string;
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
        });

        if (result.success) {
          await prisma.server.update({
            where: { id: srv.id },
            data: {
              claudeSessionPct:      result.parsed.sessionPct      ?? null,
              claudeSessionResets:   result.parsed.sessionResets    ?? null,
              claudeSessionResetsAt: result.parsed.sessionResetsAt  ?? null,
              claudeWeekPct:         result.parsed.weekPct           ?? null,
              claudeWeekResets:      result.parsed.weekResets        ?? null,
              claudeWeekResetsAt:    result.parsed.weekResetsAt      ?? null,
              claudeUsageRaw:        result.rawOutput,
              claudeUsageFetchedAt:  new Date(),
            },
          });
          console.log(
            `${TAG} ${srv.name}: session=${result.parsed.sessionPct ?? "?"}% ` +
              `week=${result.parsed.weekPct ?? "?"}%`
          );
        } else {
          console.warn(
            `${TAG} ${srv.name}: usage unavailable — ${result.status}` +
              (result.error ? `: ${result.error}` : "")
          );
        }
      })
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected")
          console.error(`${TAG} ${servers[i].name}: usage fetch threw:`, r.reason);
      });
    });

    // ── 2. Detect completion + auto-advance queue ───────────────────────────
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
        claudePermissionMode: string | null;
        claudeSessionPct: number | null;
        claudeWeekPct: number | null;
      } | null;
    }[] = [];

    try {
      runningTasks = await prisma.task.findMany({
        where: { status: "running" },
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
        const idleResult = await detectClaudeIdle({
          host: srv.host,
          port: srv.port,
          username: srv.username,
          sshKeyPath: srv.sshKeyPath,
        });

        if (!idleResult.isIdle) return;

        // Claude is idle — mark every running task on this server completed.
        for (const taskId of taskIds) {
          try {
            const latestLog = await prisma.executionLog.findFirst({
              where: { taskId, status: "running", finishedAt: null },
              orderBy: { createdAt: "desc" },
            });

            await prisma.$transaction([
              prisma.task.update({
                where: { id: taskId },
                data: { status: "completed" },
              }),
              ...(latestLog
                ? [
                    prisma.executionLog.update({
                      where: { id: latestLog.id },
                      data: { status: "completed", finishedAt: new Date() },
                    }),
                  ]
                : []),
            ]);

            console.log(
              `${TAG} Task ${taskId}: detected completion → marked completed`
            );
          } catch (err) {
            console.error(`${TAG} Task ${taskId}: failed to mark completed:`, err);
          }
        }

        // Auto-advance queue: run the next queued task on this server if usage allows.
        const sessionPct = srv.claudeSessionPct ?? 0;
        const weekPct = srv.claudeWeekPct ?? 0;

        if (sessionPct >= 90 || weekPct >= 90) {
          console.log(
            `${TAG} ${srv.name}: usage at limit (session=${sessionPct}% week=${weekPct}%), skipping queue advance`
          );
          return;
        }

        const nextTask = await prisma.task.findFirst({
          where: { serverId, status: "queued" },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          include: { project: { select: { name: true } } },
        });

        if (!nextTask) return;

        const sendResult = await sendTaskToTmux(
          {
            host: srv.host,
            port: srv.port,
            username: srv.username,
            sshKeyPath: srv.sshKeyPath,
          },
          { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name }
        );

        if (sendResult.success) {
          await prisma.$transaction([
            prisma.task.update({
              where: { id: nextTask.id },
              data: { status: "running" },
            }),
            prisma.executionLog.create({
              data: {
                taskId: nextTask.id,
                status: "running",
                startedAt: new Date(),
                logText:
                  `Auto-started from queue on server "${srv.name}" (${srv.host})` +
                  (srv.claudePermissionMode ? ` — mode: ${srv.claudePermissionMode}` : ""),
              },
            }),
          ]);
          console.log(
            `${TAG} Task ${nextTask.id} ("${nextTask.title}"): auto-started from queue`
          );
        } else {
          console.warn(
            `${TAG} Queue advance failed for task ${nextTask.id}: ${sendResult.error}`
          );
        }
      })
    ).then((results) => {
      [...byServer.values()].forEach(({ server: srv }, i) => {
        if (results[i].status === "rejected")
          console.error(`${TAG} Completion check for server ${srv.host} threw:`, results[i].reason);
      });
    });

    // ── 3. Start queued tasks on idle servers that have nothing running ────────
    // The loop above only covers servers that had running tasks. This step
    // catches servers that are idle but have queued tasks and no running tasks
    // (e.g. tasks queued before auto-run existed, or after a server restart).
    let idleServersWithQueue: {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      sshKeyPath: string;
      claudePermissionMode: string;
      claudeSessionPct: number | null;
      claudeWeekPct: number | null;
    }[] = [];

    try {
      idleServersWithQueue = await prisma.server.findMany({
        where: {
          tasks: { some: { status: "queued" } },
          AND: { tasks: { none: { status: "running" } } },
          // Skip servers already handled by the completion loop above.
          NOT: { id: { in: [...byServer.keys()] } },
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
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load queued-only servers:`, err);
    }

    await Promise.allSettled(
      idleServersWithQueue.map(async (srv) => {
        const sessionPct = srv.claudeSessionPct ?? 0;
        const weekPct = srv.claudeWeekPct ?? 0;

        if (sessionPct >= 90 || weekPct >= 90) {
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
        });

        if (!idleResult.isIdle) {
          console.log(
            `${TAG} ${srv.name}: has queued tasks but Claude is not idle yet` +
            (idleResult.error ? ` — error: ${idleResult.error}` : "") +
            (idleResult.paneText ? `\n  pane tail: ${JSON.stringify(idleResult.paneText.split("\n").filter(l => l.trim()).slice(-4))}` : "")
          );
          return;
        }

        const nextTask = await prisma.task.findFirst({
          where: { serverId: srv.id, status: "queued" },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          include: { project: { select: { name: true } } },
        });

        if (!nextTask) return;

        const sendResult = await sendTaskToTmux(
          { host: srv.host, port: srv.port, username: srv.username, sshKeyPath: srv.sshKeyPath },
          { title: nextTask.title, description: nextTask.description, projectName: nextTask.project.name }
        );

        if (sendResult.success) {
          await prisma.$transaction([
            prisma.task.update({ where: { id: nextTask.id }, data: { status: "running" } }),
            prisma.executionLog.create({
              data: {
                taskId: nextTask.id,
                status: "running",
                startedAt: new Date(),
                logText: `Auto-started from queue on server "${srv.name}" (${srv.host}) — mode: ${srv.claudePermissionMode}`,
              },
            }),
          ]);
          console.log(`${TAG} Task ${nextTask.id} ("${nextTask.title}"): dispatched from idle-server queue`);
        } else {
          console.warn(`${TAG} ${srv.name}: failed to start queued task ${nextTask.id}: ${sendResult.error}`);
        }
      })
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected")
          console.error(`${TAG} Idle-server queue check for ${idleServersWithQueue[i].host} threw:`, r.reason);
      });
    });

    console.log(`${TAG} Check complete`);
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────
  // Skip the current tick if the previous check is still running.
  let running = false;

  async function tick() {
    if (running) {
      console.log(`${TAG} Previous check still running — skipping this tick`);
      return;
    }
    running = true;
    try {
      await runCheck();
    } catch (err) {
      console.error(`${TAG} Unhandled error in runCheck:`, err);
    } finally {
      running = false;
    }
  }

  // First check 15 s after server start (DB pool warm-up), then every 60 s.
  setTimeout(() => tick(), 15_000);
  setInterval(() => tick(), 60_000);

  console.log(
    `${TAG} Background poller registered (first check in 15 s, then every 60 s)`
  );
}
