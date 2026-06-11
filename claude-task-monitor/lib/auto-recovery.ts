/**
 * Claude session auto-recovery.
 *
 * Calls launchClaudeInTmux() when a worker's Claude session is detected
 * offline (consecutiveFailures >= 2 or explicit tmuxMissing). Logs every
 * attempt to RecoveryLog. Enforces maxRecoveryAttempts cap.
 *
 * Safety rule: never recover a worker that has running tasks — relaunching
 * Claude mid-task would corrupt the session.
 */

import { prisma } from "@/lib/prisma";
import { launchClaudeInTmux, type ClaudePermissionMode } from "@/lib/ssh-claude-tmux";

export interface RecoveryResult {
  attempted: boolean;
  success: boolean;
  command?: string;
  reason?: string; // why not attempted
  error?: string;
}

// ─── Server recovery ─────────────────────────────────────────────────────────

export async function recoverServer(
  serverId: string,
  triggeredBy: "auto" | "manual" = "manual",
): Promise<RecoveryResult> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: {
      id: true, name: true, host: true, port: true, username: true, sshKeyPath: true,
      tmuxSession: true, claudePermissionMode: true,
      autoRecovery: true, recoveryAttempts: true, maxRecoveryAttempts: true,
      _count: { select: { tasks: { where: { status: "running" } } } },
    },
  });
  if (!server) return { attempted: false, success: false, reason: "not_found" };

  if (triggeredBy === "auto" && !server.autoRecovery) {
    return { attempted: false, success: false, reason: "auto_recovery_disabled" };
  }
  if (triggeredBy === "auto" && server.recoveryAttempts >= server.maxRecoveryAttempts) {
    return { attempted: false, success: false, reason: "max_attempts_reached" };
  }
  if (server._count.tasks > 0) {
    return { attempted: false, success: false, reason: "running_tasks_present" };
  }

  const result = await launchClaudeInTmux(
    { host: server.host, port: server.port, username: server.username, sshKeyPath: server.sshKeyPath },
    server.claudePermissionMode as ClaudePermissionMode,
    server.tmuxSession,
  );

  await prisma.$transaction(async (tx) => {
    await tx.recoveryLog.create({
      data: {
        serverId,
        triggeredBy,
        success: result.success,
        command: result.command,
        errorMessage: result.error ?? null,
      },
    });
    await tx.server.update({
      where: { id: serverId },
      data: {
        recoveryAttempts: { increment: 1 },
        lastRecoveryAt: new Date(),
        // Reset consecutive failures on success so health checks don't re-trigger immediately
        ...(result.success && { consecutiveFailures: 0 }),
      },
    });
  });

  console.log(
    `[recovery] server "${server.name}" (${triggeredBy}): ${result.success ? "ok" : "failed"} — ${result.command}${result.error ? ` — ${result.error}` : ""}`
  );

  return { attempted: true, success: result.success, command: result.command, error: result.error };
}

// ─── Agent recovery ───────────────────────────────────────────────────────────

export async function recoverAgent(
  agentId: string,
  triggeredBy: "auto" | "manual" = "manual",
): Promise<RecoveryResult> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true, name: true, tmuxSession: true, workDir: true, claudePermissionMode: true,
      autoRecovery: true, recoveryAttempts: true, maxRecoveryAttempts: true,
      server: { select: { host: true, port: true, username: true, sshKeyPath: true } },
      _count: { select: { tasks: { where: { status: "running" } } } },
    },
  });
  if (!agent) return { attempted: false, success: false, reason: "not_found" };

  if (triggeredBy === "auto" && !agent.autoRecovery) {
    return { attempted: false, success: false, reason: "auto_recovery_disabled" };
  }
  if (triggeredBy === "auto" && agent.recoveryAttempts >= agent.maxRecoveryAttempts) {
    return { attempted: false, success: false, reason: "max_attempts_reached" };
  }
  if (agent._count.tasks > 0) {
    return { attempted: false, success: false, reason: "running_tasks_present" };
  }

  const s = agent.server;
  const result = await launchClaudeInTmux(
    { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
    agent.claudePermissionMode as ClaudePermissionMode,
    agent.tmuxSession,
    agent.workDir,
  );

  await prisma.$transaction(async (tx) => {
    await tx.recoveryLog.create({
      data: {
        agentId,
        triggeredBy,
        success: result.success,
        command: result.command,
        errorMessage: result.error ?? null,
      },
    });
    await tx.agent.update({
      where: { id: agentId },
      data: {
        recoveryAttempts: { increment: 1 },
        lastRecoveryAt: new Date(),
        ...(result.success && { consecutiveFailures: 0, status: "idle" }),
      },
    });
  });

  console.log(
    `[recovery] agent "${agent.name}" (${triggeredBy}): ${result.success ? "ok" : "failed"} — ${result.command}${result.error ? ` — ${result.error}` : ""}`
  );

  return { attempted: true, success: result.success, command: result.command, error: result.error };
}

// ─── Scheduler sweep ─────────────────────────────────────────────────────────

const FAILURE_THRESHOLD = 2;

export async function runAutoRecovery(): Promise<void> {
  const [servers, agents] = await Promise.all([
    prisma.server.findMany({
      where: { autoRecovery: true },
      select: { id: true, name: true, consecutiveFailures: true, recoveryAttempts: true, maxRecoveryAttempts: true },
    }),
    prisma.agent.findMany({
      where: { autoRecovery: true },
      select: { id: true, name: true, consecutiveFailures: true, recoveryAttempts: true, maxRecoveryAttempts: true },
    }),
  ]);

  const eligibleServers = servers.filter(
    (s) => s.consecutiveFailures >= FAILURE_THRESHOLD && s.recoveryAttempts < s.maxRecoveryAttempts
  );
  const eligibleAgents = agents.filter(
    (a) => a.consecutiveFailures >= FAILURE_THRESHOLD && a.recoveryAttempts < a.maxRecoveryAttempts
  );

  if (eligibleServers.length === 0 && eligibleAgents.length === 0) return;

  console.log(`[recovery] auto sweep: ${eligibleServers.length} servers, ${eligibleAgents.length} agents eligible`);

  await Promise.allSettled([
    ...eligibleServers.map((s) =>
      recoverServer(s.id, "auto").catch((err) =>
        console.error(`[recovery] server "${s.name}" threw:`, err)
      )
    ),
    ...eligibleAgents.map((a) =>
      recoverAgent(a.id, "auto").catch((err) =>
        console.error(`[recovery] agent "${a.name}" threw:`, err)
      )
    ),
  ]);
}
