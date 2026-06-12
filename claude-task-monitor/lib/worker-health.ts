/**
 * Worker health evaluation — scores 0–100 based on:
 *   SSH responds   +40
 *   tmux present   +30
 *   Claude online  +20
 *   latency <500ms +10
 *
 * Writes a WorkerHealth history record and updates healthScore /
 * consecutiveFailures / lastHealthCheckAt on the Server or Agent row.
 */

import { prisma } from "@/lib/prisma";
import { execSSH, type ServerConfig } from "@/lib/ssh";
import { detectClaudeIdle } from "@/lib/ssh-claude-tmux";
import { emitWorkerUnhealthyNotification, emitDiskFullNotification } from "@/lib/notification";

export interface HealthCheckResult {
  healthScore: number;
  sshOk: boolean;
  tmuxOk: boolean;
  claudeOk: boolean;
  latencyMs: number | null;
  errorMessage: string | null;
  consecutiveFailures: number;
  diskUsedBytes: bigint | null;
  diskTotalBytes: bigint | null;
}

/** Parse `df -k <path>` output into used/total kilobytes. Returns null on failure. */
function parseDfOutput(stdout: string): { usedKb: bigint; totalKb: bigint } | null {
  // df -k output (after the header line):
  //   Filesystem     1K-blocks    Used Available Use% Mounted on
  //   /dev/xvda1     8257536   1234567   7022969  15% /
  const lines = stdout.trim().split("\n").filter((l) => l.trim().length > 0);
  // Find the data line (last non-empty line after optional header)
  const dataLine = lines[lines.length - 1];
  if (!dataLine) return null;
  const parts = dataLine.trim().split(/\s+/);
  if (parts.length < 4) return null;
  // df -k columns: Filesystem, 1K-blocks, Used, Available, Use%, Mounted
  const totalKb = BigInt(parts[1]);
  const usedKb = BigInt(parts[2]);
  if (isNaN(Number(parts[1])) || isNaN(Number(parts[2]))) return null;
  return { usedKb, totalKb };
}

async function checkWorker(
  ssh: ServerConfig,
  tmuxSession: string,
  dfPath?: string,
): Promise<HealthCheckResult> {
  let score = 0;
  let sshOk = false;
  let tmuxOk = false;
  let claudeOk = false;
  let latencyMs: number | null = null;
  let diskUsedBytes: bigint | null = null;
  let diskTotalBytes: bigint | null = null;
  const errors: string[] = [];

  // ── SSH + latency ────────────────────────────────────────────────────────
  const t0 = Date.now();
  try {
    await execSSH(ssh, "true", 10_000);
    latencyMs = Date.now() - t0;
    sshOk = true;
    score += 40;
    if (latencyMs < 500) score += 10;
  } catch (err) {
    errors.push(`SSH: ${err instanceof Error ? err.message : String(err)}`);
    return {
      healthScore: 0,
      sshOk: false,
      tmuxOk: false,
      claudeOk: false,
      latencyMs: null,
      errorMessage: errors.join("; "),
      consecutiveFailures: 0,
      diskUsedBytes: null,
      diskTotalBytes: null,
    };
  }

  // ── tmux session ─────────────────────────────────────────────────────────
  try {
    const { stdout, exitCode } = await execSSH(
      ssh,
      `tmux has-session -t ${tmuxSession} 2>&1 && echo OK || echo MISSING`,
      5_000,
    );
    if (stdout.includes("OK") || exitCode === 0) {
      tmuxOk = true;
      score += 30;
    } else {
      errors.push(`tmux session '${tmuxSession}' missing`);
    }
  } catch (err) {
    errors.push(`tmux check: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Claude process ───────────────────────────────────────────────────────
  if (tmuxOk) {
    try {
      const idleResult = await detectClaudeIdle(ssh, tmuxSession);
      if (!idleResult.tmuxMissing) {
        // Claude is online if pane has content (idle or busy — just not missing)
        const paneHasContent = idleResult.paneText.trim().length > 0;
        if (paneHasContent) {
          claudeOk = true;
          score += 20;
        } else {
          errors.push("Claude pane empty");
        }
      } else {
        errors.push("Claude tmux session not found");
      }
    } catch (err) {
      errors.push(`Claude check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Disk usage ──────────────────────────────────────────────────────────
  if (dfPath) {
    try {
      // Sanitize the path: only allow alphanumeric, /, _, -, .
      const safePath = dfPath.replace(/[^a-zA-Z0-9/_\-. ~]/g, "");
      const { stdout } = await execSSH(ssh, `df -k "${safePath}" 2>/dev/null || df -k / 2>/dev/null`, 8_000);
      const parsed = parseDfOutput(stdout);
      if (parsed) {
        diskUsedBytes = parsed.usedKb * BigInt(1024);
        diskTotalBytes = parsed.totalKb * BigInt(1024);
      }
    } catch {
      // Non-fatal — disk info is best-effort
    }
  }

  return {
    healthScore: score,
    sshOk,
    tmuxOk,
    claudeOk,
    latencyMs,
    errorMessage: errors.length > 0 ? errors.join("; ") : null,
    consecutiveFailures: 0,
    diskUsedBytes,
    diskTotalBytes,
  };
}

const DISK_ALERT_THRESHOLD = 0.9; // 90%

export async function checkServerHealth(serverId: string): Promise<HealthCheckResult | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, name: true, host: true, port: true, username: true, sshKeyPath: true, tmuxSession: true, consecutiveFailures: true, diskUsedBytes: true, diskTotalBytes: true },
  });
  if (!server) return null;

  const ssh: ServerConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    sshKeyPath: server.sshKeyPath,
  };

  // For servers, measure root filesystem disk usage
  const result = await checkWorker(ssh, server.tmuxSession, "/");
  const isHealthy = result.healthScore >= 40;
  const newFailures = isHealthy ? 0 : server.consecutiveFailures + 1;

  await prisma.$transaction(async (tx) => {
    await tx.workerHealth.create({
      data: {
        serverId,
        healthScore: result.healthScore,
        sshOk: result.sshOk,
        tmuxOk: result.tmuxOk,
        claudeOk: result.claudeOk,
        latencyMs: result.latencyMs,
        errorMessage: result.errorMessage,
      },
    });
    await tx.server.update({
      where: { id: serverId },
      data: {
        healthScore: result.healthScore,
        consecutiveFailures: newFailures,
        lastHealthCheckAt: new Date(),
        ...(result.diskUsedBytes !== null && { diskUsedBytes: result.diskUsedBytes }),
        ...(result.diskTotalBytes !== null && { diskTotalBytes: result.diskTotalBytes }),
      },
    });
    // Prune history older than 24 h to cap table growth
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await tx.workerHealth.deleteMany({
      where: { serverId, checkedAt: { lt: cutoff } },
    });
  });

  // Fire disk-full alert when utilisation first crosses 90%
  if (result.diskUsedBytes !== null && result.diskTotalBytes !== null && result.diskTotalBytes > BigInt(0)) {
    const utilisation = Number(result.diskUsedBytes) / Number(result.diskTotalBytes);
    const wasAlerted = server.diskTotalBytes !== null
      ? Number(server.diskTotalBytes) > 0 && (Number(server.diskUsedBytes ?? BigInt(0)) / Number(server.diskTotalBytes)) >= DISK_ALERT_THRESHOLD
      : false;
    if (utilisation >= DISK_ALERT_THRESHOLD && !wasAlerted) {
      emitDiskFullNotification({ resourceType: "server", resourceId: serverId, name: server.name, diskUsedBytes: result.diskUsedBytes, diskTotalBytes: result.diskTotalBytes }).catch(() => {});
    }
  }

  return { ...result, consecutiveFailures: newFailures };
}

export async function checkAgentHealth(agentId: string): Promise<HealthCheckResult | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      name: true,
      workDir: true,
      tmuxSession: true,
      consecutiveFailures: true,
      diskTotalBytes: true,
      diskUsedBytes: true,
      server: { select: { host: true, port: true, username: true, sshKeyPath: true } },
    },
  });
  if (!agent) return null;

  const ssh: ServerConfig = {
    host: agent.server.host,
    port: agent.server.port,
    username: agent.server.username,
    sshKeyPath: agent.server.sshKeyPath,
  };

  // Measure disk usage for the agent's workDir
  const result = await checkWorker(ssh, agent.tmuxSession, agent.workDir || "/");
  const isHealthy = result.healthScore >= 40;
  const newFailures = isHealthy ? 0 : agent.consecutiveFailures + 1;

  await prisma.$transaction(async (tx) => {
    await tx.workerHealth.create({
      data: {
        agentId,
        healthScore: result.healthScore,
        sshOk: result.sshOk,
        tmuxOk: result.tmuxOk,
        claudeOk: result.claudeOk,
        latencyMs: result.latencyMs,
        errorMessage: result.errorMessage,
      },
    });
    await tx.agent.update({
      where: { id: agentId },
      data: {
        healthScore: result.healthScore,
        consecutiveFailures: newFailures,
        lastHealthCheckAt: new Date(),
        ...(result.diskUsedBytes !== null && { diskUsedBytes: result.diskUsedBytes }),
        ...(result.diskTotalBytes !== null && { diskTotalBytes: result.diskTotalBytes }),
      },
    });
    // Prune history older than 24 h
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await tx.workerHealth.deleteMany({
      where: { agentId, checkedAt: { lt: cutoff } },
    });
  });

  // Fire disk-full alert when utilisation first crosses 90%
  if (result.diskUsedBytes !== null && result.diskTotalBytes !== null && result.diskTotalBytes > BigInt(0)) {
    const utilisation = Number(result.diskUsedBytes) / Number(result.diskTotalBytes);
    const wasAlerted = agent.diskTotalBytes !== null && Number(agent.diskTotalBytes) > 0
      ? (Number(agent.diskUsedBytes ?? BigInt(0)) / Number(agent.diskTotalBytes)) >= DISK_ALERT_THRESHOLD
      : false;
    if (utilisation >= DISK_ALERT_THRESHOLD && !wasAlerted) {
      emitDiskFullNotification({ resourceType: "agent", resourceId: agentId, name: agent.name, diskUsedBytes: result.diskUsedBytes, diskTotalBytes: result.diskTotalBytes }).catch(() => {});
    }
  }

  return { ...result, consecutiveFailures: newFailures };
}

export async function runHealthChecks(): Promise<void> {
  const [[servers, agents], thresholdRow] = await Promise.all([
    Promise.all([
      prisma.server.findMany({ select: { id: true, name: true } }),
      prisma.agent.findMany({ select: { id: true, name: true } }),
    ]),
    prisma.systemConfig.findUnique({
      where: { key: "worker_failure_alert_threshold" },
      select: { value: true },
    }),
  ]);

  const alertThreshold = thresholdRow
    ? (parseInt(thresholdRow.value, 10) || 3)
    : 3;

  const results = await Promise.allSettled([
    ...servers.map((s) =>
      checkServerHealth(s.id).then((r) => ({ type: "server" as const, id: s.id, name: s.name, result: r }))
    ),
    ...agents.map((a) =>
      checkAgentHealth(a.id).then((r) => ({ type: "agent" as const, id: a.id, name: a.name, result: r }))
    ),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[health] check threw:", r.reason);
    } else {
      const { type, id, name, result } = r.value;
      if (result) {
        console.log(`[health] ${type} "${name}": score=${result.healthScore} ssh=${result.sshOk} tmux=${result.tmuxOk} claude=${result.claudeOk} latency=${result.latencyMs ?? "n/a"}ms failures=${result.consecutiveFailures}`);

        // Fire a single alert exactly when the failure count crosses the threshold.
        if (result.consecutiveFailures === alertThreshold) {
          emitWorkerUnhealthyNotification({
            resourceType: type,
            resourceId: id,
            name,
            consecutiveFailures: result.consecutiveFailures,
            lastErrorMessage: result.errorMessage,
          }).catch(() => {});
          console.warn(`[health] ${type} "${name}" reached ${alertThreshold} consecutive failures — alert sent`);
        }
      }
    }
  }
}
