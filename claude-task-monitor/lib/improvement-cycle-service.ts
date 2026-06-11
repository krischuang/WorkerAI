/**
 * Continuous Improvement Engine — simplified state machine
 *
 * Flow per project:
 *   idle → scanning → awaiting_approval  (if Claude inserted suggestions)
 *                   → completed          (if no suggestions were inserted)
 *
 * Cycle is marked failed only for real execution errors:
 *   no available session, SSH failure, or Claude process timeout.
 *
 * Suggestion generation is driven by Claude writing directly to the
 * TaskSuggestion table. The app never parses Claude terminal output.
 *
 * Automation levels:
 *   0 = disabled
 *   1 = scan + suggest, stops at awaiting_approval for human approval
 *   2 = level 1 + auto-approve low-severity suggestions
 *   3 = fully autonomous; blocked when any agent uses full_autonomous mode
 */

import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";
import { runProjectScan } from "@/lib/project-scan-service";
import { approveSuggestion } from "@/lib/suggestion-service";
import { SCAN_MAX_CONSECUTIVE_FAILURES } from "@/lib/constants";
import type { Priority } from "@/app/generated/prisma/client";

const MAX_TASKS_PER_CYCLE = 10;
const CYCLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveServerForProject(projectId: string): Promise<string | null> {
  const taskWithServer = await prisma.task.findFirst({
    where: { projectId, serverId: { not: null } },
    select: { serverId: true },
    orderBy: { updatedAt: "desc" },
  });
  if (taskWithServer?.serverId) return taskWithServer.serverId;
  const server = await prisma.server.findFirst({
    where: { status: "connected" },
    select: { id: true },
  });
  return server?.id ?? null;
}

async function resolveSessionForProject(
  projectId: string,
): Promise<{ serverId: string; agentId?: string } | null> {
  const taskWithAgent = await prisma.task.findFirst({
    where: {
      projectId,
      agentId: { not: null },
      agent: { status: "idle" },
    },
    select: {
      agentId: true,
      agent: { select: { serverId: true, tmuxSession: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (taskWithAgent?.agentId && taskWithAgent.agent?.tmuxSession) {
    return { serverId: taskWithAgent.agent.serverId, agentId: taskWithAgent.agentId };
  }

  const agent = await prisma.agent.findFirst({
    where: { status: "idle", tmuxSession: { not: "" } },
    select: { id: true, serverId: true },
  });
  if (agent) return { serverId: agent.serverId, agentId: agent.id };

  const serverId = await resolveServerForProject(projectId);
  return serverId ? { serverId } : null;
}

async function isLevel3Blocked(projectId: string): Promise<boolean> {
  const agents = await prisma.agent.findMany({
    where: {
      tasks: { some: { projectId, status: { in: ["queued", "running"] } } },
    },
    select: { claudePermissionMode: true },
  });
  return agents.some((a) => a.claudePermissionMode === "full_autonomous");
}

async function fail(
  cycleId: string,
  projectId: string,
  error: string,
  countAsScanFailure = false,
) {
  await prisma.improvementCycle.update({
    where: { id: cycleId },
    data: { status: "failed", cycleError: error, completedAt: new Date() },
  });
  await emitAudit({
    entityType: "project",
    entityId: projectId,
    eventType: "improvement_cycle.failed",
    payload: { cycleId, error },
  });

  if (!countAsScanFailure) return;

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { scanFailureCount: { increment: 1 } },
    select: { scanFailureCount: true },
  });

  if (updated.scanFailureCount >= SCAN_MAX_CONSECUTIVE_FAILURES) {
    await prisma.project.update({
      where: { id: projectId },
      data: { autoImprovementPaused: true },
    });
    await emitAudit({
      entityType: "project",
      entityId: projectId,
      eventType: "improvement_cycle.auto_paused",
      payload: {
        cycleId,
        consecutiveFailures: updated.scanFailureCount,
        lastError: error,
      },
    });
    console.log(
      `[improvement-cycle] Project ${projectId} auto-paused after ${updated.scanFailureCount} consecutive scan failures`,
    );
  }
}

// ─── State handlers ──────────────────────────────────────────────────────────

/** idle → scanning */
async function handleIdle(cycle: { id: string; projectId: string; startedAt: Date }) {
  const session = await resolveSessionForProject(cycle.projectId);
  if (!session) {
    await fail(cycle.id, cycle.projectId, "No server or agent available for scan");
    return;
  }

  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: { status: "scanning" },
  });
  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.scanning",
    payload: { cycleId: cycle.id },
  });

  // Scan runs async — the .then() callback transitions the cycle when done.
  // handleScanning() provides a recovery path if the process restarts mid-scan.
  runProjectScan(cycle.projectId, session.serverId, "gap_analysis", { agentId: session.agentId })
    .then(async (result) => {
      const current = await prisma.improvementCycle.findUnique({
        where: { id: cycle.id },
        select: { status: true },
      });
      if (!current || current.status !== "scanning") return;

      if (!result.ok) {
        if (result.reason === "no_completed_tasks") {
          await prisma.improvementCycle.update({
            where: { id: cycle.id },
            data: { status: "completed", completedAt: new Date() },
          });
          return;
        }
        if (result.reason === "server_busy") {
          await prisma.improvementCycle.update({
            where: { id: cycle.id },
            data: { status: "idle" },
          });
          return;
        }
        // ssh_failed and timed_out count as scan failures.
        const isScanFailure = ["ssh_failed", "timed_out"].includes(result.reason);
        const detail = "detail" in result && result.detail ? `: ${result.detail}` : "";
        await fail(cycle.id, cycle.projectId, `${result.reason}${detail}`, isScanFailure);
        return;
      }

      // Scan succeeded — reset consecutive failure counter.
      await prisma.project.update({
        where: { id: cycle.projectId },
        data: { scanFailureCount: 0 },
      }).catch(() => {});

      // Find the ProjectScan record created for this run.
      const scan = await prisma.projectScan.findFirst({
        where: {
          projectId: cycle.projectId,
          scanType: "gap_analysis",
          status: "completed",
          startedAt: { gte: cycle.startedAt },
        },
        orderBy: { startedAt: "desc" },
        select: { id: true },
      });

      await prisma.improvementCycle.update({
        where: { id: cycle.id },
        data: {
          status: result.suggestionsInserted > 0 ? "awaiting_approval" : "completed",
          suggestionsGenerated: result.suggestionsInserted,
          scanId: scan?.id ?? null,
          ...(result.suggestionsInserted === 0 && { completedAt: new Date() }),
        },
      });

      await emitAudit({
        entityType: "project",
        entityId: cycle.projectId,
        eventType: result.suggestionsInserted > 0
          ? "improvement_cycle.awaiting_approval"
          : "improvement_cycle.completed",
        payload: { cycleId: cycle.id, suggestionsInserted: result.suggestionsInserted },
      });
    })
    .catch(async (err) => {
      const current = await prisma.improvementCycle.findUnique({
        where: { id: cycle.id },
        select: { status: true },
      });
      if (!current || current.status !== "scanning") return;
      await fail(cycle.id, cycle.projectId, String(err)).catch(() => {});
    });
}

/**
 * scanning: recovery check that runs each poller tick.
 * The .then() callback in handleIdle is the primary advancer;
 * this handles the case where a process restart lost the callback.
 */
async function handleScanning(cycle: { id: string; projectId: string; startedAt: Date }) {
  const scan = await prisma.projectScan.findFirst({
    where: {
      projectId: cycle.projectId,
      scanType: "gap_analysis",
      status: { in: ["completed", "failed"] },
      startedAt: { gte: cycle.startedAt },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true, errorMessage: true },
  });
  if (!scan) return;

  // Idempotent guard — .then() may have already advanced the state.
  const current = await prisma.improvementCycle.findUnique({
    where: { id: cycle.id },
    select: { status: true },
  });
  if (!current || current.status !== "scanning") return;

  if (scan.status === "failed") {
    const reason = scan.errorMessage ?? "unknown";
    await fail(cycle.id, cycle.projectId, `Gap analysis scan failed: ${reason}`, true);
    return;
  }

  // Successful recovery — reset consecutive failure counter.
  await prisma.project.update({
    where: { id: cycle.projectId },
    data: { scanFailureCount: 0 },
  }).catch(() => {});

  // Count suggestions inserted by the recovered scan.
  const suggestionsInserted = await prisma.taskSuggestion.count({
    where: { projectId: cycle.projectId, sourceId: scan.id, sourceType: "scan" },
  });

  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: {
      status: suggestionsInserted > 0 ? "awaiting_approval" : "completed",
      suggestionsGenerated: suggestionsInserted,
      scanId: scan.id,
      ...(suggestionsInserted === 0 && { completedAt: new Date() }),
    },
  });
}

// ─── Public: advance active cycles ───────────────────────────────────────────

/**
 * Advance all in-progress improvement cycles by one state transition.
 * Called each poller tick — non-blocking.
 */
export async function advanceImprovementCycles(): Promise<void> {
  const activeCycles = await prisma.improvementCycle.findMany({
    where: { status: { notIn: ["completed", "cancelled", "failed"] } },
    include: { project: { select: { cycleFrequencyDays: true } } },
    orderBy: { startedAt: "asc" },
  });

  for (const cycle of activeCycles) {
    const age = Date.now() - cycle.startedAt.getTime();
    if (age > CYCLE_TIMEOUT_MS) {
      await fail(cycle.id, cycle.projectId, "7-day cycle timeout exceeded");
      continue;
    }

    try {
      switch (cycle.status) {
        case "idle":
          if (cycle.automationLevel >= 3 && await isLevel3Blocked(cycle.projectId)) {
            await fail(cycle.id, cycle.projectId, "Level 3 blocked: agent uses full_autonomous permission mode");
            break;
          }
          await handleIdle(cycle);
          break;

        case "scanning":
          await handleScanning(cycle);
          break;

        case "awaiting_approval":
          // Human must act — nothing to advance automatically at level 1.
          // Levels 2/3: auto-approve eligible suggestions.
          if (cycle.automationLevel >= 2) {
            await autoApproveSuggestions(cycle);
          }
          break;

        // Legacy states from in-flight cycles created before this simplification.
        // Advance them to completed so they don't remain stuck.
        case "detecting_debt":
        case "generating_suggestions":
        case "executing":
        case "reviewing":
          await prisma.improvementCycle.update({
            where: { id: cycle.id },
            data: { status: "completed", completedAt: new Date() },
          });
          break;
      }
    } catch (err) {
      console.error(`[improvement-cycle] Error advancing cycle ${cycle.id} (${cycle.status}):`, err);
      await fail(cycle.id, cycle.projectId, String(err)).catch(() => {});
    }
  }
}

/**
 * Auto-approve pending suggestions based on automation level:
 *   level 2 — approve only P3/P4 (low-severity)
 *   level 3 — approve all
 */
async function autoApproveSuggestions(cycle: {
  id: string;
  projectId: string;
  automationLevel: number;
  startedAt: Date;
}) {
  const filter = cycle.automationLevel >= 3
    ? {}
    : { priority: { in: ["P3", "P4"] as Priority[] } };

  const suggestions = await prisma.taskSuggestion.findMany({
    where: {
      projectId: cycle.projectId,
      status: "pending_review",
      createdAt: { gte: cycle.startedAt },
      ...filter,
    },
    select: { id: true },
    take: MAX_TASKS_PER_CYCLE,
  });

  if (suggestions.length === 0) return;

  let approved = 0;
  for (const s of suggestions) {
    const result = await approveSuggestion(s.id);
    if (result.ok) approved++;
  }

  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: {
      suggestionsApproved: { increment: approved },
      tasksCreated: { increment: approved },
      status: "completed",
      completedAt: new Date(),
    },
  });

  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.tasks_created",
    payload: { cycleId: cycle.id, created: approved },
  });
}

// ─── Public: start due cycles ─────────────────────────────────────────────────

export async function startDueImprovementCycles(): Promise<void> {
  const now = new Date();

  const projects = await prisma.project.findMany({
    where: {
      status: "active",
      improvementAutomationLevel: { gte: 1 },
      autoImprovementPaused: false,
      OR: [
        { nextImprovementCycleAt: { lte: now } },
        { nextImprovementCycleAt: null },
      ],
    },
    select: {
      id: true,
      name: true,
      improvementAutomationLevel: true,
      cycleFrequencyDays: true,
      nextImprovementCycleAt: true,
      lastImprovementCycleAt: true,
    },
  });

  for (const project of projects) {
    const active = await prisma.improvementCycle.count({
      where: { projectId: project.id, status: { notIn: ["completed", "cancelled", "failed"] } },
    });
    if (active > 0) continue;

    if (!project.lastImprovementCycleAt && !project.nextImprovementCycleAt) {
      const nextAt = new Date(now.getTime() + (project.cycleFrequencyDays ?? 7) * 86_400_000);
      await prisma.project.update({
        where: { id: project.id },
        data: { nextImprovementCycleAt: nextAt },
      });
      continue;
    }

    const cycle = await prisma.improvementCycle.create({
      data: {
        projectId: project.id,
        automationLevel: project.improvementAutomationLevel,
        status: "idle",
        startedAt: now,
      },
    });

    await emitAudit({
      entityType: "project",
      entityId: project.id,
      eventType: "improvement_cycle.started",
      payload: { cycleId: cycle.id, automationLevel: project.improvementAutomationLevel },
    });

    console.log(
      `[improvement-cycle] Started cycle ${cycle.id} for project "${project.name}" (level ${project.improvementAutomationLevel})`
    );
  }
}

// ─── Public: human actions ────────────────────────────────────────────────────

/**
 * Approve all pending suggestions for a cycle and advance to completed.
 * This is the bulk-approve convenience action — individual suggestions can
 * also be approved via the Suggestions tab.
 */
export async function approveCycle(cycleId: string): Promise<{ ok: boolean; error?: string }> {
  const cycle = await prisma.improvementCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, projectId: true, automationLevel: true, status: true, startedAt: true },
  });
  if (!cycle) return { ok: false, error: "Not found" };
  if (cycle.status !== "awaiting_approval") {
    return { ok: false, error: `Cycle is in "${cycle.status}", not awaiting_approval` };
  }

  const suggestions = await prisma.taskSuggestion.findMany({
    where: {
      projectId: cycle.projectId,
      status: "pending_review",
      createdAt: { gte: cycle.startedAt },
    },
    select: { id: true },
    take: MAX_TASKS_PER_CYCLE,
  });

  let approved = 0;
  for (const s of suggestions) {
    const result = await approveSuggestion(s.id);
    if (result.ok) approved++;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.improvementCycle.update({
      where: { id: cycleId },
      data: {
        status: "completed",
        completedAt: now,
        suggestionsApproved: approved,
        tasksCreated: approved,
      },
    });
    await tx.project.update({
      where: { id: cycle.projectId },
      data: { lastImprovementCycleAt: now },
    });
  });

  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.approved",
    actorType: "user",
    payload: { cycleId, suggestionsApproved: approved },
  });

  return { ok: true };
}

/**
 * Cancel an in-progress improvement cycle.
 */
export async function cancelCycle(cycleId: string): Promise<{ ok: boolean; error?: string }> {
  const cycle = await prisma.improvementCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, projectId: true, status: true },
  });
  if (!cycle) return { ok: false, error: "Not found" };
  if (["completed", "cancelled", "failed"].includes(cycle.status)) {
    return { ok: false, error: `Cycle already in terminal state "${cycle.status}"` };
  }

  await prisma.improvementCycle.update({
    where: { id: cycleId },
    data: { status: "cancelled", completedAt: new Date() },
  });

  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.cancelled",
    actorType: "user",
    payload: { cycleId },
  });

  return { ok: true };
}
