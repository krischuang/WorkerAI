import { prisma } from "./prisma";

const TAG = "[log-archival]";

/** exitReason values for structured completion tracking */
export type ExitReason =
  | "completion_marker"
  | "idle_fallback"
  | "session_gone"
  | "timeout"
  | "manual"
  | "error";

/** Map the completedHow string from the poller to a structured exitReason. */
export function completedHowToExitReason(completedHow: string): ExitReason {
  if (completedHow === "completion marker") return "completion_marker";
  if (completedHow === "session gone") return "session_gone";
  if (completedHow.startsWith("idle")) return "idle_fallback";
  return "idle_fallback";
}

/** Extract last N lines from a pane capture string. */
export function lastNLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * Nightly archival of execution logs older than the configured retention period.
 *
 * Retention is read from SystemConfig key "execution_log_retention_days" (default: 90).
 * Sets archivedAt, nulls out logText and paneCapture (large fields),
 * preserving outputSummary, errorMessage, durationMs, exitReason.
 */
export async function archiveOldLogs(): Promise<{ archived: number }> {
  // Read retention period from config; fall back to 90 days.
  let retentionDays = 90;
  try {
    const cfg = await prisma.systemConfig.findUnique({
      where: { key: "execution_log_retention_days" },
      select: { value: true },
    });
    if (cfg) {
      const parsed = parseInt(cfg.value, 10);
      if (!isNaN(parsed) && parsed > 0) retentionDays = parsed;
    }
  } catch {
    // Non-fatal — continue with default.
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  try {
    const { count } = await prisma.executionLog.updateMany({
      where: {
        finishedAt: { lt: cutoff },
        archivedAt: null,
      },
      data: {
        archivedAt: new Date(),
        logText: null,
        paneCapture: null,
      },
    });
    console.log(`${TAG} Archived ${count} execution logs (retention: ${retentionDays} days, cutoff: ${cutoff.toISOString().slice(0, 10)})`);
    return { archived: count };
  } catch (err) {
    console.error(`${TAG} archiveOldLogs failed:`, err);
    return { archived: 0 };
  }
}

/**
 * Returns true if 1 AM UTC has been reached today and we haven't run archival yet.
 * Caller should persist `_lastArchivalDate` in globalThis.
 */
export function shouldRunNightlyArchival(lastArchivalDate: string | null): boolean {
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  if (lastArchivalDate === todayUTC) return false;
  // Run if UTC hour >= 1
  return now.getUTCHours() >= 1;
}
