/**
 * Self-healing orchestrator — called once per poller cycle.
 *
 * Flow per cycle:
 *  1. Detect anomalies in agent state
 *  2. Create incidents (deduped)
 *  3. Create repair tasks (deduped)
 *  4. Execute pending repair tasks (V1 auto-repair sources)
 *  5. Write audit log
 *  6. Resolve incidents whose repair passed validation
 */

import { prisma } from "@/lib/prisma";
import { detectIncidents, V1_AUTO_REPAIR_SOURCES } from "./incident-detector";
import { createIncidentIfNew, resolveIncident, setIncidentStatus } from "./incident-service";
import { createRepairTaskIfNew, getPendingRepairTasks, updateRepairTaskStatus, nextAttemptNumber } from "./repair-task-service";
import { executeRepair } from "./repair-executor";
import { writeRepairAuditLog } from "./repair-audit";
import { isSubsystemHalted } from "@/lib/kill-switch";

const TAG = "[self-healing]";

function repairTaskInputFor(source: string, agentName: string) {
  const isV1 = V1_AUTO_REPAIR_SOURCES.has(source);

  const map: Record<string, { title: string; description: string; suggestedSteps: string[] }> = {
    usage_fetch_failure: {
      title: `Fix usage fetch failure on ${agentName}`,
      description: "Claude CLI usage fetch is returning errors. Restart the session to recover.",
      suggestedSteps: [
        "Restart the Claude CLI tmux session",
        "Verify usage can be fetched with confidence >= medium",
      ],
    },
    usage_parse_error: {
      title: `Fix usage parse error on ${agentName}`,
      description: "Claude CLI usage output cannot be parsed. Restart the session to clear the pane.",
      suggestedSteps: [
        "Restart the Claude CLI tmux session",
        "Verify the pane returns parseable /usage output",
      ],
    },
    usage_timeout: {
      title: `Fix usage fetch timeout on ${agentName}`,
      description: "Usage fetch is timing out. Restart the session to unblock.",
      suggestedSteps: [
        "Restart the Claude CLI tmux session",
        "Verify usage fetch completes within the timeout window",
      ],
    },
    stale_usage_data: {
      title: `Refresh stale usage data on ${agentName}`,
      description: "Cached usage data is older than 10 minutes. Force a fresh fetch.",
      suggestedSteps: [
        "Force a manual usage refresh",
        "Verify claudeUsageFetchedAt is updated",
      ],
    },
    invalid_usage_value: {
      title: `Fix invalid usage value on ${agentName}`,
      description: "Stored session or week percentage is outside [0, 100]. Force a fresh fetch.",
      suggestedSteps: [
        "Force a manual usage refresh to overwrite the bad value",
        "Verify the new value is in range [0, 100]",
      ],
    },
    stuck_agent: {
      title: `Reset stuck agent ${agentName}`,
      description: "Agent is marked running but has no active tasks. Reset to idle.",
      suggestedSteps: [
        "Mark all orphaned running tasks as failed",
        "Reset agent status to idle and activeTaskCount to 0",
      ],
    },
  };

  const meta = map[source] ?? {
    title: `Investigate ${source} on ${agentName}`,
    description: `Unknown incident source "${source}". Manual investigation required.`,
    suggestedSteps: ["Inspect agent logs", "Review related source code", "Apply fix manually"],
  };

  return { ...meta, riskLevel: "low" as const, isV1 };
}

export async function runSelfHealingCycle(): Promise<void> {
  // Kill switch: skip entire cycle when self-healing is halted
  if (await isSubsystemHalted("selfHealing")) {
    console.log(`${TAG} skipping cycle — kill switch active (selfHealing halted)`);
    return;
  }

  // ── 1. Detect anomalies ────────────────────────────────────────────────────
  let detections;
  try {
    detections = await detectIncidents();
  } catch (err) {
    console.error(`${TAG} detectIncidents threw:`, err);
    return;
  }

  if (detections.length > 0) {
    console.log(`${TAG} ${detections.length} anomaly detection(s) this cycle`);
  }

  // ── 2. Create incidents + repair tasks ────────────────────────────────────
  const incidentTaskPairs: Array<{ incidentId: string; taskId: string; source: string; affectedAgentId: string | null }> = [];

  for (const d of detections) {
    try {
      const { incidentId, isNew: incidentIsNew } = await createIncidentIfNew(d);
      if (incidentIsNew) {
        console.log(`${TAG} New incident [${d.source}] for agent ${d.affectedAgentId}: ${d.title}`);
      }

      const agentName = d.contextJson["agentName"] as string ?? d.affectedAgentId ?? "unknown";
      const taskInput = repairTaskInputFor(d.source, agentName);

      const { taskId, isNew: taskIsNew } = await createRepairTaskIfNew(incidentId, {
        title: taskInput.title,
        description: taskInput.description,
        suggestedSteps: taskInput.suggestedSteps,
        riskLevel: taskInput.riskLevel,
      });

      if (taskIsNew) {
        console.log(`${TAG} New repair task for incident ${incidentId}: "${taskInput.title}"`);
      }

      // For non-V1 sources, immediately mark needs_human_review
      if (!taskInput.isV1) {
        await updateRepairTaskStatus(taskId, "needs_human_review");
        console.log(`${TAG} Task ${taskId} marked needs_human_review (source="${d.source}")`);
        continue;
      }

      incidentTaskPairs.push({
        incidentId,
        taskId,
        source: d.source,
        affectedAgentId: d.affectedAgentId ?? null,
      });
    } catch (err) {
      console.error(`${TAG} Error creating incident/task for detection ${d.source}:`, err);
    }
  }

  // ── 3. Execute pending repair tasks ───────────────────────────────────────
  const pendingTasks = await getPendingRepairTasks().catch(() => []);

  for (const repairTask of pendingTasks) {
    const source = repairTask.incident.source;
    if (!V1_AUTO_REPAIR_SOURCES.has(source)) continue;

    // Mark in_progress to prevent concurrent execution
    await updateRepairTaskStatus(repairTask.id, "in_progress").catch(() => {});

    const attemptNum = await nextAttemptNumber(repairTask.id);

    const attempt = await prisma.repairAttempt.create({
      data: {
        repairTaskId: repairTask.id,
        attemptNumber: attemptNum,
        executedBy: "system",
        status: "running",
      },
      select: { id: true },
    });

    console.log(`${TAG} Executing repair task "${repairTask.title}" (attempt #${attemptNum})`);

    let result;
    try {
      result = await executeRepair(source, repairTask.incident.affectedAgentId ?? null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result = {
        success: false,
        logs: `Repair threw: ${errorMessage}`,
        validationOutput: "error",
        validationPassed: false,
        changedFiles: [],
        errorMessage,
      };
    }

    // Update the attempt record
    await prisma.repairAttempt.update({
      where: { id: attempt.id },
      data: {
        logs: result.logs.slice(0, 4000),
        validationOutput: result.validationOutput,
        validationPassed: result.validationPassed,
        changedFiles: result.changedFiles,
        commitHash: result.commitHash ?? null,
        status: result.success ? "completed" : "failed",
        completedAt: new Date(),
      },
    }).catch(() => {});

    // Update repair task status
    const finalStatus = result.validationPassed
      ? "fixed"
      : "failed_validation";

    await updateRepairTaskStatus(repairTask.id, finalStatus);

    // Resolve or leave incident open
    if (result.validationPassed) {
      await resolveIncident(repairTask.incidentId).catch(() => {});
      console.log(`${TAG} Repair succeeded for task "${repairTask.title}"`);
    } else {
      await setIncidentStatus(repairTask.incidentId, "investigating").catch(() => {});
      console.warn(`${TAG} Repair failed validation for task "${repairTask.title}": ${result.validationOutput}`);
    }

    // Write audit log
    await writeRepairAuditLog({
      incidentId: repairTask.incidentId,
      repairTaskId: repairTask.id,
      assignedAgentId: null,
      status: finalStatus,
      validationResult: result.validationOutput,
      changedFiles: result.changedFiles,
      commitHash: result.commitHash,
      pushStatus: result.changedFiles.length > 0 ? (result.commitHash ? "pushed" : "not_pushed") : "not_applicable",
      errorMessage: result.errorMessage,
    });
  }
}
