import { prisma } from "./prisma";

const TAG = "[log-archival]";

/** Default retention windows for high-volume append-only tables. */
const WORKER_HEALTH_RETENTION_DAYS = 7;
const AGENT_SNAPSHOT_RETENTION_DAYS = 7;
const AUDIT_EVENT_RETENTION_DAYS = 90;
const ADMIN_AUDIT_RETENTION_DAYS = 365;
const SERVER_CMD_LOG_RETENTION_DAYS = 30;

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
 * Prune high-volume append-only tables that have no hard archival step.
 * Called nightly alongside archiveOldLogs.
 *
 * Retention periods:
 *   WorkerHealth        7 days  — dense per-worker per-cycle rows
 *   AgentUsageSnapshot  7 days  — one row per agent per poll cycle
 *   AuditEvent         90 days  — state-change event log
 *   AdminAuditLog     365 days  — admin action log
 *   ServerCommandLog   30 days  — SSH command history
 */
export async function pruneHighVolumeTables(): Promise<{
  workerHealth: number;
  agentSnapshots: number;
  auditEvents: number;
  adminAuditLogs: number;
  serverCmdLogs: number;
}> {
  const now = Date.now();
  const cutoffFor = (days: number) => new Date(now - days * 86_400_000);

  const results = { workerHealth: 0, agentSnapshots: 0, auditEvents: 0, adminAuditLogs: 0, serverCmdLogs: 0 };

  try {
    const r = await prisma.workerHealth.deleteMany({ where: { checkedAt: { lt: cutoffFor(WORKER_HEALTH_RETENTION_DAYS) } } });
    results.workerHealth = r.count;
  } catch (err) { console.error(`${TAG} pruneWorkerHealth failed:`, err); }

  try {
    const r = await prisma.agentUsageSnapshot.deleteMany({ where: { capturedAt: { lt: cutoffFor(AGENT_SNAPSHOT_RETENTION_DAYS) } } });
    results.agentSnapshots = r.count;
  } catch (err) { console.error(`${TAG} pruneAgentUsageSnapshot failed:`, err); }

  try {
    const r = await prisma.auditEvent.deleteMany({ where: { createdAt: { lt: cutoffFor(AUDIT_EVENT_RETENTION_DAYS) } } });
    results.auditEvents = r.count;
  } catch (err) { console.error(`${TAG} pruneAuditEvent failed:`, err); }

  try {
    const r = await prisma.adminAuditLog.deleteMany({ where: { createdAt: { lt: cutoffFor(ADMIN_AUDIT_RETENTION_DAYS) } } });
    results.adminAuditLogs = r.count;
  } catch (err) { console.error(`${TAG} pruneAdminAuditLog failed:`, err); }

  try {
    const r = await prisma.serverCommandLog.deleteMany({ where: { createdAt: { lt: cutoffFor(SERVER_CMD_LOG_RETENTION_DAYS) } } });
    results.serverCmdLogs = r.count;
  } catch (err) { console.error(`${TAG} pruneServerCommandLog failed:`, err); }

  const total = Object.values(results).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log(
      `${TAG} Pruned high-volume tables: workerHealth=${results.workerHealth}, ` +
      `agentSnapshots=${results.agentSnapshots}, auditEvents=${results.auditEvents}, ` +
      `adminAuditLogs=${results.adminAuditLogs}, serverCmdLogs=${results.serverCmdLogs}`
    );
  }
  return results;
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
