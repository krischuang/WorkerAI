import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";
import { IMPROVEMENT_SCAN_TIMEOUT_MS, SCAN_MAX_CONSECUTIVE_FAILURES } from "@/lib/constants";

export function isStuckScan(startedAt: Date, now = Date.now()): boolean {
  return now - startedAt.getTime() > IMPROVEMENT_SCAN_TIMEOUT_MS;
}

export function isStuckCycle(
  cycleStatus: string,
  cycleStartedAt: Date,
  scan: { startedAt: Date; status: string } | null,
  now = Date.now(),
): boolean {
  if (cycleStatus !== "scanning") return false;
  if (scan !== null) return isStuckScan(scan.startedAt, now);
  // Allow 60s buffer for the scan record to be created before declaring stuck
  return now - cycleStartedAt.getTime() > IMPROVEMENT_SCAN_TIMEOUT_MS + 60_000;
}

export interface ScanHealth {
  id: string;
  status: string;
  startedAt: Date;
  durationMs: number;
  errorMessage: string | null;
  isStuck: boolean;
}

export interface CycleHealth {
  activeCycle: {
    id: string;
    status: string;
    startedAt: Date;
    durationMs: number;
    cycleError: string | null;
    isStuck: boolean;
    suggestionsGenerated: number;
  } | null;
  activeScan: ScanHealth | null;
  scanFailureCount: number;
  autoImprovementPaused: boolean;
  isStuck: boolean;
  stuckReason: string | null;
  pendingSuggestionsCount: number;
}

export interface RecoverySummary {
  scansRecovered: number;
  cyclesRecovered: number;
  scanFailureCountBefore: number;
  scanFailureCountAfter: number;
  autoImprovementPaused: boolean;
}

export async function getCycleHealth(projectId: string): Promise<CycleHealth | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, scanFailureCount: true, autoImprovementPaused: true },
  });
  if (!project) return null;

  const now = Date.now();

  const activeCycleRaw = await prisma.improvementCycle.findFirst({
    where: {
      projectId,
      status: { notIn: ["completed", "cancelled", "failed"] },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true, startedAt: true, cycleError: true, suggestionsGenerated: true },
  });

  const pendingSuggestionsCount = await prisma.taskSuggestion.count({
    where: { projectId, status: "pending_review" },
  });

  const activeScanRaw = await prisma.projectScan.findFirst({
    where: { projectId, status: "running" },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true, startedAt: true, errorMessage: true },
  });

  const activeScan: ScanHealth | null = activeScanRaw
    ? {
        id: activeScanRaw.id,
        status: activeScanRaw.status,
        startedAt: activeScanRaw.startedAt,
        durationMs: now - activeScanRaw.startedAt.getTime(),
        errorMessage: activeScanRaw.errorMessage,
        isStuck: isStuckScan(activeScanRaw.startedAt, now),
      }
    : null;

  const scanIsStuck = activeScan !== null && activeScan.isStuck;

  const cycleIsStuck =
    activeCycleRaw !== null &&
    isStuckCycle(activeCycleRaw.status, activeCycleRaw.startedAt, activeScanRaw, now);

  const isStuck = scanIsStuck || cycleIsStuck;

  let stuckReason: string | null = null;
  if (scanIsStuck && cycleIsStuck) {
    stuckReason = `Cycle stuck in '${activeCycleRaw!.status}' and scan stuck for ${Math.floor((now - activeScan!.startedAt.getTime()) / 1000)}s (timeout: ${IMPROVEMENT_SCAN_TIMEOUT_MS / 1000}s)`;
  } else if (scanIsStuck) {
    stuckReason = `Scan stuck for ${Math.floor((now - activeScan!.startedAt.getTime()) / 1000)}s (timeout: ${IMPROVEMENT_SCAN_TIMEOUT_MS / 1000}s)`;
  } else if (cycleIsStuck) {
    stuckReason = `Cycle stuck in '${activeCycleRaw!.status}' with no running scan for ${Math.floor((now - activeCycleRaw!.startedAt.getTime()) / 1000)}s`;
  }

  return {
    activeCycle: activeCycleRaw
      ? {
          id: activeCycleRaw.id,
          status: activeCycleRaw.status,
          startedAt: activeCycleRaw.startedAt,
          durationMs: now - activeCycleRaw.startedAt.getTime(),
          cycleError: activeCycleRaw.cycleError,
          isStuck: cycleIsStuck,
          suggestionsGenerated: activeCycleRaw.suggestionsGenerated,
        }
      : null,
    activeScan,
    scanFailureCount: project.scanFailureCount,
    autoImprovementPaused: project.autoImprovementPaused,
    isStuck,
    stuckReason,
    pendingSuggestionsCount,
  };
}

export async function recoverStuckCycle(projectId: string): Promise<RecoverySummary | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, scanFailureCount: true, autoImprovementPaused: true },
  });
  if (!project) return null;

  const cutoff = new Date(Date.now() - IMPROVEMENT_SCAN_TIMEOUT_MS);

  const stuckScans = await prisma.projectScan.findMany({
    where: { projectId, status: "running", startedAt: { lte: cutoff } },
    select: { id: true },
  });

  if (stuckScans.length > 0) {
    await prisma.projectScan.updateMany({
      where: { id: { in: stuckScans.map((s) => s.id) } },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: "recovered: scan timed out (process restart killed poll loop)",
      },
    });
  }

  const stuckCycles = await prisma.improvementCycle.findMany({
    where: { projectId, status: "scanning" },
    select: { id: true },
  });

  if (stuckCycles.length > 0) {
    await prisma.improvementCycle.updateMany({
      where: { id: { in: stuckCycles.map((c) => c.id) } },
      data: {
        status: "failed",
        cycleError: "recovered: stuck in scanning state",
        completedAt: new Date(),
      },
    });

    const newCount = project.scanFailureCount + stuckCycles.length;
    const shouldPause = newCount >= SCAN_MAX_CONSECUTIVE_FAILURES;

    await prisma.project.update({
      where: { id: projectId },
      data: {
        scanFailureCount: { increment: stuckCycles.length },
        ...(shouldPause && { autoImprovementPaused: true }),
      },
    });
  }

  const updated = await prisma.project.findUnique({
    where: { id: projectId },
    select: { scanFailureCount: true, autoImprovementPaused: true },
  });

  const summary: RecoverySummary = {
    scansRecovered: stuckScans.length,
    cyclesRecovered: stuckCycles.length,
    scanFailureCountBefore: project.scanFailureCount,
    scanFailureCountAfter: updated?.scanFailureCount ?? project.scanFailureCount,
    autoImprovementPaused: updated?.autoImprovementPaused ?? project.autoImprovementPaused,
  };

  await emitAudit({
    entityType: "project",
    entityId: projectId,
    eventType: "improvement_cycle.recovered",
    actorType: "user",
    payload: { ...summary },
  });

  const pauseNewlySet = !project.autoImprovementPaused && (updated?.autoImprovementPaused ?? false);
  if (pauseNewlySet) {
    await emitAudit({
      entityType: "project",
      entityId: projectId,
      eventType: "improvement_cycle.auto_paused",
      actorType: "system",
      payload: { scanFailureCount: updated?.scanFailureCount, reason: "recovery triggered pause threshold" },
    });
  }

  return summary;
}
