/**
 * Node.js-only instrumentation — loaded by instrumentation.ts only in the Node runtime.
 *
 * Starts a background poller that fires every 60 seconds:
 *   1. Fetches Claude CLI usage for every server via tmux and persists it to the DB.
 *   2. Checks every running task's assigned server for Claude idle state; if idle,
 *      marks the task completed and closes its open ExecutionLog.
 *
 * Deduplication: a `globalThis` flag prevents a second interval from being
 * registered when Turbopack reloads modules during development.
 */

export async function register() {
  // Prevent duplicate intervals on hot-reload (Turbopack dev mode).
  const g = globalThis as unknown as { _usagePollerStarted?: boolean };
  if (g._usagePollerStarted) return;
  g._usagePollerStarted = true;

  // Lazy imports — keeps instrumentation.ts safe to parse during Next.js build
  // analysis even before the generated Prisma client exists.
  const { prisma } = await import("./lib/prisma");
  const { fetchClaudeUsageViaTmux, detectClaudeIdle } = await import(
    "./lib/ssh-claude-tmux"
  );

  const TAG = "[usage-poller]";

  // ── Core polling logic ──────────────────────────────────────────────────────

  async function runCheck() {
    const ts = new Date().toISOString();
    console.log(`${TAG} ${ts} — starting usage + completion check`);

    // ── 1. Refresh Claude usage for every server ──────────────────────────────
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

    for (const srv of servers) {
      try {
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
              claudeSessionPct:      result.parsed.sessionPct    ?? null,
              claudeSessionResets:   result.parsed.sessionResets  ?? null,
              claudeSessionResetsAt: result.parsed.sessionResetsAt ?? null,
              claudeWeekPct:         result.parsed.weekPct         ?? null,
              claudeWeekResets:      result.parsed.weekResets      ?? null,
              claudeWeekResetsAt:    result.parsed.weekResetsAt    ?? null,
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
      } catch (err) {
        console.error(`${TAG} ${srv.name}: usage fetch threw:`, err);
      }
    }

    // ── 2. Detect completion for running tasks ────────────────────────────────
    let runningTasks: {
      id: string;
      serverId: string | null;
      server: {
        host: string;
        port: number;
        username: string;
        sshKeyPath: string;
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
              host: true,
              port: true,
              username: true,
              sshKeyPath: true,
            },
          },
        },
      });
    } catch (err) {
      console.error(`${TAG} Failed to load running tasks:`, err);
    }

    // Group tasks by server to avoid redundant SSH connections.
    type ServerConfig = { host: string; port: number; username: string; sshKeyPath: string };
    const byServer = new Map<string, { config: ServerConfig; taskIds: string[] }>();

    for (const task of runningTasks) {
      if (!task.serverId || !task.server) continue;
      const entry = byServer.get(task.serverId);
      if (entry) {
        entry.taskIds.push(task.id);
      } else {
        byServer.set(task.serverId, { config: task.server, taskIds: [task.id] });
      }
    }

    for (const [, { config, taskIds }] of byServer) {
      try {
        const idleResult = await detectClaudeIdle(config);

        if (!idleResult.isIdle) continue;

        // Claude is idle — all tasks running on this server are done.
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

            console.log(`${TAG} Task ${taskId}: detected completion → marked completed`);
          } catch (err) {
            console.error(`${TAG} Task ${taskId}: failed to mark completed:`, err);
          }
        }
      } catch (err) {
        console.error(
          `${TAG} Completion check for server ${config.host} threw:`,
          err
        );
      }
    }

    console.log(`${TAG} Check complete`);
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────
  // Guard against concurrent runs: if the previous check is still in progress,
  // skip the current tick rather than stacking calls.
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

  // First check: 15 s after server start (let the DB pool warm up).
  setTimeout(() => tick(), 15_000);

  // Recurring: every 60 s.
  setInterval(() => tick(), 60_000);

  console.log(`${TAG} Background poller registered (first check in 15 s, then every 60 s)`);
}
