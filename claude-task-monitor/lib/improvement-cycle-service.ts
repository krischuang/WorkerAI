/**
 * Continuous Improvement Engine
 *
 * 8-state machine per project:
 *   idle → scanning → detecting_debt → generating_suggestions
 *     → awaiting_approval → executing → reviewing → completed
 *     → (schedule next cycle)
 *
 * One state transition per poller tick — non-blocking.
 *
 * Automation levels:
 *   0 = disabled (no cycles started)
 *   1 = scan + detect + suggest, stops at awaiting_approval for human approval
 *   2 = level 1 + auto-approve low-severity suggestions
 *   3 = fully autonomous (auto-approve all, wait for execution,
 *       auto-review, schedule next); blocked when any agent uses full_autonomous mode
 *
 * Safeguards:
 *   - max 10 tasks created per cycle
 *   - Level 3 blocked when any assigned agent uses full_autonomous Claude perm
 *   - 7-day cycle hard timeout → transition to failed
 *   - all significant state changes emit AuditEvent records
 */

import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";
import { runProjectScan } from "@/lib/project-scan-service";
import { runDebtScan } from "@/lib/debt-scan-service";

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

async function isLevel3Blocked(projectId: string): Promise<boolean> {
  const agents = await prisma.agent.findMany({
    where: {
      tasks: { some: { projectId, status: { in: ["queued", "running"] } } },
    },
    select: { claudePermissionMode: true },
  });
  return agents.some((a) => a.claudePermissionMode === "full_autonomous");
}

async function fail(cycleId: string, projectId: string, error: string) {
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
}

// ─── State handlers ──────────────────────────────────────────────────────────

/** idle → scanning */
async function handleIdle(cycle: { id: string; projectId: string; startedAt: Date }) {
  const serverId = await resolveServerForProject(cycle.projectId);
  if (!serverId) {
    await fail(cycle.id, cycle.projectId, "No server available for scan");
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

  // Primary state advancer: async callback fires when scan completes
  runProjectScan(cycle.projectId, serverId, "gap_analysis")
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
        const detail = "detail" in result && result.detail ? `: ${result.detail}` : "";
        await fail(cycle.id, cycle.projectId, `${result.reason}${detail}`);
        return;
      }

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
        data: { status: "detecting_debt", scanId: scan?.id ?? null },
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
    select: { id: true, status: true },
  });
  if (!scan) return;

  // Idempotent guard — .then() may have already advanced the state
  const current = await prisma.improvementCycle.findUnique({
    where: { id: cycle.id },
    select: { status: true },
  });
  if (!current || current.status !== "scanning") return;

  if (scan.status === "failed") {
    await fail(cycle.id, cycle.projectId, "Gap analysis scan failed");
    return;
  }
  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: { status: "detecting_debt", scanId: scan.id },
  });
}

/** detecting_debt → generating_suggestions; debt scan runs async in background */
async function handleDetectingDebt(cycle: { id: string; projectId: string }) {
  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: { status: "generating_suggestions" },
  });

  // Background debt scan — results available for suggestions step if it completes in time,
  // otherwise they'll be picked up by the next cycle
  resolveServerForProject(cycle.projectId).then((serverId) => {
    if (!serverId) return;
    runDebtScan(cycle.projectId, serverId).catch((err) => {
      console.warn(`[improvement-cycle] Background debt scan failed for ${cycle.projectId}: ${err}`);
    });
  });
}

/** generating_suggestions → awaiting_approval | executing */
async function handleGeneratingSuggestions(cycle: {
  id: string;
  projectId: string;
  automationLevel: number;
}) {
  const latestScan = await prisma.projectScan.findFirst({
    where: { projectId: cycle.projectId, status: "completed", scanType: "gap_analysis" },
    orderBy: { completedAt: "desc" },
    select: { findings: true },
  });

  const findings = (latestScan?.findings ?? []) as Array<{
    title: string;
    severity?: string;
    suggestedAction?: string;
    description?: string;
  }>;

  const openDebt = await prisma.debtItem.findMany({
    where: { projectId: cycle.projectId, status: "open" },
    orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
    take: MAX_TASKS_PER_CYCLE,
    select: { title: true, description: true, severity: true },
  });

  type Suggestion = { title: string; description: string; severity: string; source: string };
  const suggestions: Suggestion[] = [];

  for (const f of findings) {
    if (f.suggestedAction?.trim() && suggestions.length < MAX_TASKS_PER_CYCLE) {
      suggestions.push({
        title: f.title,
        description: (f.suggestedAction ?? "") + (f.description ? `\n\n${f.description}` : ""),
        severity: f.severity ?? "medium",
        source: "scan",
      });
    }
  }

  for (const d of openDebt) {
    if (suggestions.length >= MAX_TASKS_PER_CYCLE) break;
    suggestions.push({
      title: `Fix: ${d.title}`,
      description: d.description,
      severity: d.severity,
      source: "debt",
    });
  }

  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: { suggestionsGenerated: suggestions.length },
  });

  if (suggestions.length === 0) {
    await prisma.improvementCycle.update({
      where: { id: cycle.id },
      data: { status: "completed", completedAt: new Date() },
    });
    await emitAudit({
      entityType: "project",
      entityId: cycle.projectId,
      eventType: "improvement_cycle.completed",
      payload: { cycleId: cycle.id, reason: "no_suggestions" },
    });
    return;
  }

  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.suggestions_generated",
    payload: { cycleId: cycle.id, count: suggestions.length },
  });

  if (cycle.automationLevel === 1) {
    await prisma.improvementCycle.update({
      where: { id: cycle.id },
      data: { status: "awaiting_approval" },
    });
    return;
  }

  // Level 2: auto-approve low-severity only; higher severity waits for human
  // Level 3: auto-approve all
  const toCreate = cycle.automationLevel >= 3
    ? suggestions
    : suggestions.filter((s) => s.severity === "low");

  if (toCreate.length === 0) {
    await prisma.improvementCycle.update({
      where: { id: cycle.id },
      data: { status: "awaiting_approval" },
    });
    return;
  }

  await createTasksFromSuggestions(cycle, toCreate);
}

async function createTasksFromSuggestions(
  cycle: { id: string; projectId: string },
  suggestions: Array<{ title: string; description: string; severity: string; source: string }>,
) {
  let created = 0;
  for (const s of suggestions.slice(0, MAX_TASKS_PER_CYCLE)) {
    const priority =
      s.severity === "critical" ? "P1"
      : s.severity === "high" ? "P2"
      : s.severity === "medium" ? "P3"
      : "P4";
    await prisma.task.create({
      data: {
        projectId: cycle.projectId,
        title: s.title.slice(0, 200),
        description: s.description.slice(0, 2000),
        priority: priority as never,
        taskType: "maintenance",
        status: "pending",
      },
    });
    created++;
  }

  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: { status: "executing", tasksCreated: created, suggestionsApproved: suggestions.length },
  });

  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.tasks_created",
    payload: { cycleId: cycle.id, created },
  });
}

/** executing → reviewing */
async function handleExecuting(cycle: {
  id: string;
  projectId: string;
  automationLevel: number;
  startedAt: Date;
}) {
  if (cycle.automationLevel < 3) {
    // Levels 1/2: tasks are run manually; just move to reviewing
    await prisma.improvementCycle.update({
      where: { id: cycle.id },
      data: { status: "reviewing" },
    });
    return;
  }

  // Level 3: wait until no cycle tasks remain pending/queued/running
  const pendingCount = await prisma.task.count({
    where: {
      projectId: cycle.projectId,
      createdAt: { gte: cycle.startedAt },
      status: { in: ["queued", "running", "pending"] },
    },
  });
  if (pendingCount > 0) return;

  const doneCount = await prisma.task.count({
    where: {
      projectId: cycle.projectId,
      createdAt: { gte: cycle.startedAt },
      status: { in: ["completed", "archived"] },
    },
  });

  await prisma.improvementCycle.update({
    where: { id: cycle.id },
    data: { status: "reviewing", tasksExecuted: doneCount },
  });
}

/** reviewing → completed */
async function handleReviewing(cycle: {
  id: string;
  projectId: string;
  cycleFrequencyDays: number;
}) {
  const now = new Date();
  const nextCycleAt = new Date(now.getTime() + cycle.cycleFrequencyDays * 86_400_000);

  await prisma.$transaction(async (tx) => {
    await tx.improvementCycle.update({
      where: { id: cycle.id },
      data: { status: "completed", completedAt: now, nextCycleAt },
    });
    await tx.project.update({
      where: { id: cycle.projectId },
      data: { lastImprovementCycleAt: now, nextImprovementCycleAt: nextCycleAt },
    });
  });

  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.completed",
    payload: { cycleId: cycle.id, nextCycleAt: nextCycleAt.toISOString() },
  });
}

// ─── Public: advance active cycles ───────────────────────────────────────────

/**
 * Advance all in-progress improvement cycles by one state transition.
 * Called each poller tick — non-blocking (one transition per cycle per tick).
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

        case "detecting_debt":
          await handleDetectingDebt(cycle);
          break;

        case "generating_suggestions":
          await handleGeneratingSuggestions(cycle);
          break;

        case "awaiting_approval":
          break; // Human must call the approve API

        case "executing":
          await handleExecuting({
            id: cycle.id,
            projectId: cycle.projectId,
            automationLevel: cycle.automationLevel,
            startedAt: cycle.startedAt,
          });
          break;

        case "reviewing":
          await handleReviewing({
            id: cycle.id,
            projectId: cycle.projectId,
            cycleFrequencyDays: cycle.project.cycleFrequencyDays,
          });
          break;
      }
    } catch (err) {
      console.error(`[improvement-cycle] Error advancing cycle ${cycle.id} (${cycle.status}):`, err);
      await fail(cycle.id, cycle.projectId, String(err)).catch(() => {});
    }
  }
}

// ─── Public: start due cycles ─────────────────────────────────────────────────

/**
 * Start new improvement cycles for projects that are due.
 * Called each poller tick after advanceImprovementCycles().
 */
export async function startDueImprovementCycles(): Promise<void> {
  const now = new Date();

  const projects = await prisma.project.findMany({
    where: {
      status: "active",
      improvementAutomationLevel: { gte: 1 },
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

    // Brand-new project: schedule first cycle at one freq-period from now
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
 * Approve all suggestions in an awaiting_approval cycle and advance to executing.
 */
export async function approveCycle(cycleId: string): Promise<{ ok: boolean; error?: string }> {
  const cycle = await prisma.improvementCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, projectId: true, automationLevel: true, status: true },
  });
  if (!cycle) return { ok: false, error: "Not found" };
  if (cycle.status !== "awaiting_approval") {
    return { ok: false, error: `Cycle is in "${cycle.status}", not awaiting_approval` };
  }

  const latestScan = await prisma.projectScan.findFirst({
    where: { projectId: cycle.projectId, status: "completed", scanType: "gap_analysis" },
    orderBy: { completedAt: "desc" },
    select: { findings: true },
  });

  const findings = (latestScan?.findings ?? []) as Array<{
    title: string; severity?: string; suggestedAction?: string; description?: string;
  }>;

  const openDebt = await prisma.debtItem.findMany({
    where: { projectId: cycle.projectId, status: "open" },
    orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
    take: MAX_TASKS_PER_CYCLE,
    select: { title: true, description: true, severity: true },
  });

  const suggestions = [
    ...findings
      .filter((f) => f.suggestedAction?.trim())
      .map((f) => ({
        title: f.title,
        description: (f.suggestedAction ?? "") + (f.description ? `\n\n${f.description}` : ""),
        severity: f.severity ?? "medium",
        source: "scan",
      })),
    ...openDebt.map((d) => ({
      title: `Fix: ${d.title}`,
      description: d.description,
      severity: d.severity,
      source: "debt",
    })),
  ].slice(0, MAX_TASKS_PER_CYCLE);

  await createTasksFromSuggestions(cycle, suggestions);

  await emitAudit({
    entityType: "project",
    entityId: cycle.projectId,
    eventType: "improvement_cycle.approved",
    actorType: "user",
    payload: { cycleId, suggestionsApproved: suggestions.length },
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
