/**
 * Zombie task detection — identifies running tasks with no measurable output
 * progress over a configurable stall threshold, confirmed across two
 * consecutive poller cycles before auto-failing.
 *
 * Detection flow (per running task each cycle):
 *   1. Capture current pane line count from the task's tmux session.
 *   2. If line count grew since last cycle: update lastProgressAt, clear any
 *      pending stallDetectedAt, reset in-memory baseline.
 *   3. If no growth AND time since lastProgressAt > stall_threshold_minutes:
 *      - First detection: write stallDetectedAt = now (no fail yet).
 *      - Already detected (stallDetectedAt set from a previous cycle): FAIL.
 *
 * In-memory line-count baseline (globalThis._zombiePaneLines) survives HMR
 * and tracks across cycles without an extra DB column.
 */

import { prisma } from "@/lib/prisma";
import { execSSH } from "@/lib/ssh";
import { killTaskTmuxSession } from "@/lib/ssh-claude-tmux";
import { emitNotification } from "@/lib/notification";

const TAG = "[zombie]";

// ─── SystemConfig helpers ─────────────────────────────────────────────────────

const DEFAULT_STALL_MIN = 30;
export async function getSystemConfig(key: string, defaultValue: string): Promise<string> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  return row?.value ?? defaultValue;
}

// ─── In-memory pane-line baseline ────────────────────────────────────────────

declare global {
  var _zombiePaneLines: Map<string, number> | undefined;
}

function getPaneLineMap(): Map<string, number> {
  if (!globalThis._zombiePaneLines) globalThis._zombiePaneLines = new Map();
  return globalThis._zombiePaneLines;
}

// ─── Capture pane line count for a session ───────────────────────────────────

async function getPaneLineCount(
  ssh: { host: string; port: number; username: string; sshKeyPath: string },
  session: string,
): Promise<number | null> {
  try {
    const { stdout, exitCode } = await execSSH(
      ssh,
      `tmux capture-pane -t ${session} -p -S -5000 2>/dev/null | wc -l`,
      8_000,
    );
    if (exitCode !== 0) return null;
    const n = parseInt(stdout.trim(), 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

// ─── Force-fail a single task ─────────────────────────────────────────────────

export async function forceFailTask(
  taskId: string,
  reason = "Force-failed by operator",
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: taskId },
      data: { status: "failed", stallDetectedAt: null },
    });
    const log = await tx.executionLog.findFirst({
      where: { taskId, status: "running", finishedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (log) {
      await tx.executionLog.update({
        where: { id: log.id },
        data: { status: "failed", finishedAt: new Date(), errorMessage: reason },
      });
    }
  });
  getPaneLineMap().delete(taskId);
  emitNotification(taskId, "task.failed").catch(() => {});
}

// ─── Main zombie scan ─────────────────────────────────────────────────────────

export async function detectZombieTasks(): Promise<void> {
  const stallMinStr = await getSystemConfig("stall_threshold_minutes", String(DEFAULT_STALL_MIN));
  const stallThresholdMs = Math.max(1, parseInt(stallMinStr, 10)) * 60_000;

  // Load all running tasks with their assigned server / agent ssh info.
  const runningTasks = await prisma.task.findMany({
    where: { status: "running" },
    select: {
      id: true,
      taskTmuxSession: true,
      tmuxOutputOffset: true,
      lastProgressAt: true,
      stallDetectedAt: true,
      updatedAt: true,
      executionLogs: {
        where: { status: "running", finishedAt: null },
        orderBy: { startedAt: "asc" },
        take: 1,
        select: { startedAt: true },
      },
      server: { select: { host: true, port: true, username: true, sshKeyPath: true, tmuxSession: true } },
      agent: {
        select: {
          tmuxSession: true,
          server: { select: { host: true, port: true, username: true, sshKeyPath: true } },
        },
      },
    },
  });

  const paneMap = getPaneLineMap();
  const now = Date.now();

  await Promise.allSettled(
    runningTasks.map(async (task) => {
      // Resolve SSH config and session name.
      let sshConfig: { host: string; port: number; username: string; sshKeyPath: string } | null = null;
      let sessionName: string | null = null;

      if (task.taskTmuxSession && task.server) {
        sshConfig = task.server;
        sessionName = task.taskTmuxSession;
      } else if (task.agent) {
        sshConfig = task.agent.server;
        sessionName = task.agent.tmuxSession;
      } else if (task.server) {
        sshConfig = task.server;
        sessionName = task.server.tmuxSession;
      }

      if (!sshConfig || !sessionName) return;

      // Reference point: when did the task actually start running?
      const startedAt = task.executionLogs[0]?.startedAt ?? task.updatedAt;
      const elapsedMs = now - startedAt.getTime();

      // Skip tasks that haven't been running long enough to be stalled yet.
      if (elapsedMs < stallThresholdMs) return;

      const currentLines = await getPaneLineCount(sshConfig, sessionName);
      if (currentLines === null) return; // can't read pane — skip

      const baseline = paneMap.get(task.id);

      // Determine if there's been progress since the last cycle.
      const hasProgress = baseline === undefined || currentLines > baseline;
      paneMap.set(task.id, currentLines);

      const lastProgress = task.lastProgressAt ?? startedAt;
      const noProgressMs = now - lastProgress.getTime();

      if (hasProgress) {
        // Task is making progress — update timestamp and clear stall flag.
        const updates: Record<string, unknown> = { lastProgressAt: new Date() };
        if (task.stallDetectedAt) updates.stallDetectedAt = null;
        await prisma.task.update({ where: { id: task.id }, data: updates });
        return;
      }

      // No progress this cycle.
      if (noProgressMs < stallThresholdMs) return; // not stalled long enough yet

      if (!task.stallDetectedAt) {
        // First detection — mark it but don't fail yet (one more cycle needed).
        await prisma.task.update({
          where: { id: task.id },
          data: { stallDetectedAt: new Date() },
        });
        console.log(`${TAG} task "${task.id}": stall detected — waiting one more cycle to confirm`);
        return;
      }

      // stallDetectedAt is set from a prior cycle — confirmed zombie, fail it.
      const stallMin = Math.round(noProgressMs / 60_000);
      const errorMessage = `Zombie task: no progress for ${stallMin}min — auto-failed`;
      console.log(`${TAG} task "${task.id}": confirmed zombie (${stallMin}min stall) — failing`);

      await forceFailTask(task.id, errorMessage);

      // Kill the per-task tmux session if present.
      if (task.taskTmuxSession) {
        await killTaskTmuxSession(sshConfig, task.id).catch(() => {});
      }

      console.log(`[ZOMBIE_KILLED] taskId="${task.id}" stallMin=${stallMin}`);
    })
  );
}
