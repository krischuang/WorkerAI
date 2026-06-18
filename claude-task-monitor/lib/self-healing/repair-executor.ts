/**
 * Executes repairs for V1 auto-repair incident sources.
 * All V1 repairs are system-executed (no Claude agent needed).
 *
 * V1 repair map:
 *   usage_fetch_failure  → restart Claude CLI session; validate by re-fetching usage
 *   usage_parse_error    → restart Claude CLI session; validate by re-fetching usage
 *   usage_timeout        → restart Claude CLI session; validate by re-fetching usage
 *   stale_usage_data     → force fresh usage fetch; validate timestamp updated
 *   invalid_usage_value  → force fresh usage fetch; validate values in range
 *   stuck_agent          → reset agent status to idle; mark orphaned tasks failed
 */

import { prisma } from "@/lib/prisma";
import {
  fetchClaudeUsageReliable,
  launchClaudeInTmux,
  type ClaudePermissionMode,
} from "@/lib/ssh-claude-tmux";
import { recordUsageSnapshot } from "@/lib/usage-snapshot-service";

export interface RepairResult {
  success: boolean;
  logs: string;
  validationOutput: string;
  validationPassed: boolean;
  changedFiles: string[];
  commitHash?: string;
  errorMessage?: string;
}

type AgentWithServer = {
  id: string;
  name: string;
  tmuxSession: string;
  workDir: string;
  claudePermissionMode: string;
  status: string;
  server: {
    host: string;
    port: number;
    username: string;
    sshKeyPath: string;
  };
};

async function loadAgent(agentId: string): Promise<AgentWithServer | null> {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      name: true,
      tmuxSession: true,
      workDir: true,
      claudePermissionMode: true,
      status: true,
      server: {
        select: { host: true, port: true, username: true, sshKeyPath: true },
      },
    },
  });
}

/** Restart Claude CLI session and validate by re-fetching usage. */
async function repairByRestartingSession(agent: AgentWithServer): Promise<RepairResult> {
  const logs: string[] = [];
  const ssh = {
    host: agent.server.host,
    port: agent.server.port,
    username: agent.server.username,
    sshKeyPath: agent.server.sshKeyPath,
  };

  try {
    logs.push(`Restarting Claude CLI session "${agent.tmuxSession}" for agent "${agent.name}"…`);
    await launchClaudeInTmux(
      ssh,
      agent.claudePermissionMode as ClaudePermissionMode,
      agent.tmuxSession,
      agent.workDir || undefined,
    );
    logs.push("Session restart command sent. Waiting 5 s for stabilisation…");
    await new Promise((r) => setTimeout(r, 5_000));

    logs.push("Fetching usage to validate…");
    const result = await fetchClaudeUsageReliable(ssh, agent.tmuxSession, "manual_refresh");
    await recordUsageSnapshot(agent.id, result, "manual_refresh");

    const validationPassed =
      result.confidence === "high" || result.confidence === "medium";
    const validationOutput = validationPassed
      ? `Usage fetch succeeded (confidence=${result.confidence}, session=${result.parsed.sessionPct}%, week=${result.parsed.weekPct}%)`
      : `Usage fetch still failing after restart (confidence=${result.confidence}, status=${result.status})`;

    logs.push(validationOutput);

    return {
      success: validationPassed,
      logs: logs.join("\n"),
      validationOutput,
      validationPassed,
      changedFiles: [],
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logs.push(`Error during session restart: ${errorMessage}`);
    return {
      success: false,
      logs: logs.join("\n"),
      validationOutput: `Repair failed: ${errorMessage}`,
      validationPassed: false,
      changedFiles: [],
      errorMessage,
    };
  }
}

/** Force a fresh usage fetch and validate the result. */
async function repairByForcingUsageFetch(
  agent: AgentWithServer,
  source: string,
): Promise<RepairResult> {
  const logs: string[] = [];
  const ssh = {
    host: agent.server.host,
    port: agent.server.port,
    username: agent.server.username,
    sshKeyPath: agent.server.sshKeyPath,
  };

  try {
    logs.push(`Forcing usage refresh for agent "${agent.name}"…`);
    const result = await fetchClaudeUsageReliable(ssh, agent.tmuxSession, "manual_refresh");
    await recordUsageSnapshot(agent.id, result, "manual_refresh");

    let validationPassed = false;
    let validationOutput = "";

    if (source === "invalid_usage_value") {
      const sp = result.parsed.sessionPct ?? null;
      const wp = result.parsed.weekPct ?? null;
      validationPassed =
        result.confidence !== "failed" &&
        (sp === null || (sp >= 0 && sp <= 100)) &&
        (wp === null || (wp >= 0 && wp <= 100));
      validationOutput = validationPassed
        ? `Values now valid (session=${sp}%, week=${wp}%)`
        : `Values still invalid or fetch failed (session=${sp}%, week=${wp}%, confidence=${result.confidence})`;
    } else {
      // stale_usage_data
      const fetched = new Date();
      const agentNow = await prisma.agent.findUnique({
        where: { id: agent.id },
        select: { claudeUsageFetchedAt: true },
      });
      const STALE_OK_THRESHOLD_MS = 2 * 60 * 1000;
      validationPassed =
        agentNow?.claudeUsageFetchedAt != null &&
        fetched.getTime() - agentNow.claudeUsageFetchedAt.getTime() < STALE_OK_THRESHOLD_MS;
      validationOutput = validationPassed
        ? `Usage data refreshed (confidence=${result.confidence})`
        : `Usage data still stale after force refresh (confidence=${result.confidence})`;
    }

    logs.push(validationOutput);

    return {
      success: validationPassed,
      logs: logs.join("\n"),
      validationOutput,
      validationPassed,
      changedFiles: [],
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logs.push(`Error during usage refresh: ${errorMessage}`);
    return {
      success: false,
      logs: logs.join("\n"),
      validationOutput: `Repair failed: ${errorMessage}`,
      validationPassed: false,
      changedFiles: [],
      errorMessage,
    };
  }
}

/** Reset a stuck agent: mark orphaned running tasks failed, set agent idle. */
async function repairStuckAgent(agent: AgentWithServer): Promise<RepairResult> {
  const logs: string[] = [];

  try {
    logs.push(`Resetting stuck agent "${agent.name}" (status=${agent.status})…`);

    const orphanedTasks = await prisma.task.findMany({
      where: { agentId: agent.id, status: "running" },
      select: { id: true, title: true },
    });

    if (orphanedTasks.length > 0) {
      logs.push(`Found ${orphanedTasks.length} orphaned running task(s). Marking as failed…`);
      await prisma.task.updateMany({
        where: { agentId: agent.id, status: "running" },
        data: { status: "failed", lastFailReason: "agent_stuck_reset" },
      });
      for (const t of orphanedTasks) {
        logs.push(`  → Task "${t.title}" (${t.id}) marked failed`);
      }
    } else {
      logs.push("No orphaned running tasks found.");
    }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: "idle", activeTaskCount: 0 },
    });
    logs.push("Agent status reset to idle.");

    // Validate
    const updated = await prisma.agent.findUnique({
      where: { id: agent.id },
      select: { status: true, activeTaskCount: true },
    });
    const validationPassed = updated?.status === "idle";
    const validationOutput = validationPassed
      ? `Agent is now idle (activeTaskCount=${updated?.activeTaskCount ?? 0})`
      : `Agent status is still "${updated?.status}" — reset may have failed`;

    logs.push(validationOutput);

    return {
      success: validationPassed,
      logs: logs.join("\n"),
      validationOutput,
      validationPassed,
      changedFiles: [],
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logs.push(`Error resetting stuck agent: ${errorMessage}`);
    return {
      success: false,
      logs: logs.join("\n"),
      validationOutput: `Repair failed: ${errorMessage}`,
      validationPassed: false,
      changedFiles: [],
      errorMessage,
    };
  }
}

export async function executeRepair(
  incidentSource: string,
  affectedAgentId: string | null,
): Promise<RepairResult> {
  if (!affectedAgentId) {
    return {
      success: false,
      logs: "No affected agent ID — cannot execute repair.",
      validationOutput: "skipped",
      validationPassed: false,
      changedFiles: [],
      errorMessage: "No affected agent ID",
    };
  }

  const agent = await loadAgent(affectedAgentId);
  if (!agent) {
    return {
      success: false,
      logs: `Agent ${affectedAgentId} not found — may have been deleted.`,
      validationOutput: "skipped",
      validationPassed: false,
      changedFiles: [],
      errorMessage: "Agent not found",
    };
  }

  switch (incidentSource) {
    case "usage_fetch_failure":
    case "usage_parse_error":
    case "usage_timeout":
      return repairByRestartingSession(agent);

    case "stale_usage_data":
    case "invalid_usage_value":
      return repairByForcingUsageFetch(agent, incidentSource);

    case "stuck_agent":
      return repairStuckAgent(agent);

    default:
      return {
        success: false,
        logs: `No V1 auto-repair defined for source "${incidentSource}".`,
        validationOutput: "skipped — needs_human_review",
        validationPassed: false,
        changedFiles: [],
      };
  }
}
