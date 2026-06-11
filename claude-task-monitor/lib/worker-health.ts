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

export interface HealthCheckResult {
  healthScore: number;
  sshOk: boolean;
  tmuxOk: boolean;
  claudeOk: boolean;
  latencyMs: number | null;
  errorMessage: string | null;
}

async function checkWorker(
  ssh: ServerConfig,
  tmuxSession: string,
): Promise<HealthCheckResult> {
  let score = 0;
  let sshOk = false;
  let tmuxOk = false;
  let claudeOk = false;
  let latencyMs: number | null = null;
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

  return {
    healthScore: score,
    sshOk,
    tmuxOk,
    claudeOk,
    latencyMs,
    errorMessage: errors.length > 0 ? errors.join("; ") : null,
  };
}

export async function checkServerHealth(serverId: string): Promise<HealthCheckResult | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, host: true, port: true, username: true, sshKeyPath: true, tmuxSession: true, consecutiveFailures: true },
  });
  if (!server) return null;

  const ssh: ServerConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    sshKeyPath: server.sshKeyPath,
  };

  const result = await checkWorker(ssh, server.tmuxSession);
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
      },
    });
    // Prune history older than 24 h to cap table growth
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await tx.workerHealth.deleteMany({
      where: { serverId, checkedAt: { lt: cutoff } },
    });
  });

  return result;
}

export async function checkAgentHealth(agentId: string): Promise<HealthCheckResult | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      tmuxSession: true,
      consecutiveFailures: true,
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

  const result = await checkWorker(ssh, agent.tmuxSession);
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
      },
    });
    // Prune history older than 24 h
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await tx.workerHealth.deleteMany({
      where: { agentId, checkedAt: { lt: cutoff } },
    });
  });

  return result;
}

export async function runHealthChecks(): Promise<void> {
  const [servers, agents] = await Promise.all([
    prisma.server.findMany({ select: { id: true, name: true } }),
    prisma.agent.findMany({ select: { id: true, name: true } }),
  ]);

  const results = await Promise.allSettled([
    ...servers.map((s) =>
      checkServerHealth(s.id).then((r) => ({ type: "server", name: s.name, result: r }))
    ),
    ...agents.map((a) =>
      checkAgentHealth(a.id).then((r) => ({ type: "agent", name: a.name, result: r }))
    ),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[health] check threw:", r.reason);
    } else {
      const { type, name, result } = r.value;
      if (result) {
        console.log(`[health] ${type} "${name}": score=${result.healthScore} ssh=${result.sshOk} tmux=${result.tmuxOk} claude=${result.claudeOk} latency=${result.latencyMs ?? "n/a"}ms`);
      }
    }
  }
}
