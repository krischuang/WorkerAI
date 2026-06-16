import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";
import { isTemplatePlaceholder } from "@/lib/scan-helpers";
import { classifyTaskRisk } from "@/lib/risk-classifier";

const MAX_SUGGESTIONS_PER_RUN = 10;

function severityToPriority(severity: string): "P1" | "P2" | "P3" | "P4" {
  if (severity === "critical") return "P1";
  if (severity === "high") return "P2";
  if (severity === "medium") return "P3";
  return "P4";
}

/** Fetch existing open suggestion titles for de-duplication */
async function existingOpenTitles(projectId: string): Promise<Set<string>> {
  const rows = await prisma.taskSuggestion.findMany({
    where: { projectId, status: { in: ["pending_review", "approved"] } },
    select: { title: true },
  });
  return new Set(rows.map((r) => r.title.toLowerCase().trim()));
}

export async function generateSuggestionsFromScan(scanId: string): Promise<number> {
  const scan = await prisma.projectScan.findUnique({
    where: { id: scanId },
    select: { id: true, projectId: true, findings: true, status: true },
  });
  if (!scan || scan.status !== "completed") return 0;

  const findings = (scan.findings ?? []) as Array<{
    title?: string;
    severity?: string;
    description?: string;
    suggestedAction?: string;
  }>;

  const open = await existingOpenTitles(scan.projectId);
  let created = 0;

  for (const f of findings) {
    if (created >= MAX_SUGGESTIONS_PER_RUN) break;
    if (!f.title || !f.suggestedAction?.trim()) continue;
    if (isTemplatePlaceholder(f.title) || isTemplatePlaceholder(f.suggestedAction)) continue;
    const normTitle = f.title.toLowerCase().trim();
    if (open.has(normTitle)) continue;

    const priority = severityToPriority(f.severity ?? "medium");
    await prisma.taskSuggestion.create({
      data: {
        projectId: scan.projectId,
        sourceType: "scan",
        sourceId: scanId,
        title: f.title.slice(0, 200),
        description: (f.suggestedAction + (f.description ? `\n\n${f.description}` : "")).slice(0, 2000),
        priority,
        taskType: "maintenance",
        estimatedCostLevel: "medium",
        rationale: `Found in gap analysis scan (severity: ${f.severity ?? "medium"})`,
        status: "pending_review",
      },
    });
    open.add(normTitle);
    created++;
  }

  if (created > 0) {
    await emitAudit({
      entityType: "project",
      entityId: scan.projectId,
      eventType: "suggestions.generated",
      payload: { scanId, count: created, source: "scan" },
    });
  }

  return created;
}

export async function generateSuggestionFromDebt(debtItemId: string): Promise<boolean> {
  const debt = await prisma.debtItem.findUnique({
    where: { id: debtItemId },
    select: { id: true, projectId: true, title: true, description: true, severity: true, category: true },
  });
  if (!debt) return false;

  const normTitle = `fix: ${debt.title}`.toLowerCase().trim();
  const existing = await prisma.taskSuggestion.findFirst({
    where: { projectId: debt.projectId, sourceId: debtItemId, status: { in: ["pending_review", "approved"] } },
  });
  if (existing) return false;

  const open = await existingOpenTitles(debt.projectId);
  if (open.has(normTitle)) return false;

  const priority = severityToPriority(debt.severity);
  await prisma.taskSuggestion.create({
    data: {
      projectId: debt.projectId,
      sourceType: "debt",
      sourceId: debtItemId,
      title: `Fix: ${debt.title}`.slice(0, 200),
      description: debt.description.slice(0, 2000),
      priority,
      taskType: "maintenance",
      estimatedCostLevel: debt.severity === "critical" || debt.severity === "high" ? "high" : "medium",
      rationale: `Technical debt item — category: ${debt.category}, severity: ${debt.severity}`,
      status: "pending_review",
    },
  });

  await emitAudit({
    entityType: "project",
    entityId: debt.projectId,
    eventType: "suggestions.generated",
    payload: { debtItemId, source: "debt" },
  });

  return true;
}

export async function generateSuggestionsForProject(projectId: string): Promise<number> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) return 0;

  const open = await existingOpenTitles(projectId);
  let created = 0;

  // From latest completed scan
  const latestScan = await prisma.projectScan.findFirst({
    where: { projectId, status: "completed" },
    orderBy: { completedAt: "desc" },
    select: { id: true, findings: true },
  });

  if (latestScan) {
    const findings = (latestScan.findings ?? []) as Array<{
      title?: string; severity?: string; description?: string; suggestedAction?: string;
    }>;
    for (const f of findings) {
      if (created >= MAX_SUGGESTIONS_PER_RUN) break;
      if (!f.title || !f.suggestedAction?.trim()) continue;
      if (isTemplatePlaceholder(f.title) || isTemplatePlaceholder(f.suggestedAction)) continue;
      const normTitle = f.title.toLowerCase().trim();
      if (open.has(normTitle)) continue;
      const priority = severityToPriority(f.severity ?? "medium");
      await prisma.taskSuggestion.create({
        data: {
          projectId,
          sourceType: "scan",
          sourceId: latestScan.id,
          title: f.title.slice(0, 200),
          description: (f.suggestedAction + (f.description ? `\n\n${f.description}` : "")).slice(0, 2000),
          priority,
          taskType: "maintenance",
          estimatedCostLevel: "medium",
          rationale: `Found in gap analysis scan (severity: ${f.severity ?? "medium"})`,
          status: "pending_review",
        },
      });
      open.add(normTitle);
      created++;
    }
  }

  // From open debt items
  const openDebt = await prisma.debtItem.findMany({
    where: { projectId, status: "open" },
    orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
    take: MAX_SUGGESTIONS_PER_RUN,
  });

  for (const d of openDebt) {
    if (created >= MAX_SUGGESTIONS_PER_RUN) break;
    const normTitle = `fix: ${d.title}`.toLowerCase().trim();
    if (open.has(normTitle)) continue;
    const existing = await prisma.taskSuggestion.findFirst({
      where: { projectId, sourceId: d.id, status: { in: ["pending_review", "approved"] } },
    });
    if (existing) continue;
    const priority = severityToPriority(d.severity);
    await prisma.taskSuggestion.create({
      data: {
        projectId,
        sourceType: "debt",
        sourceId: d.id,
        title: `Fix: ${d.title}`.slice(0, 200),
        description: d.description.slice(0, 2000),
        priority,
        taskType: "maintenance",
        estimatedCostLevel: d.severity === "critical" || d.severity === "high" ? "high" : "medium",
        rationale: `Technical debt — category: ${d.category}, severity: ${d.severity}`,
        status: "pending_review",
      },
    });
    open.add(normTitle);
    created++;
  }

  if (created > 0) {
    await emitAudit({
      entityType: "project",
      entityId: projectId,
      eventType: "suggestions.generated",
      payload: { count: created, source: "manual" },
    });
  }

  return created;
}

export async function approveSuggestion(
  suggestionId: string,
  opts?: { isAutonomous?: boolean },
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const s = await prisma.taskSuggestion.findUnique({ where: { id: suggestionId } });
  if (!s) return { ok: false, error: "Not found" };
  if (s.status !== "pending_review") return { ok: false, error: `Suggestion is already ${s.status}` };

  const riskLevel = classifyTaskRisk({ title: s.title, description: s.description, taskType: s.taskType });

  const task = await prisma.$transaction(async (tx) => {
    const t = await tx.task.create({
      data: {
        projectId: s.projectId,
        title: s.title,
        description: s.description,
        priority: s.priority,
        taskType: s.taskType,
        estimatedCostLevel: s.estimatedCostLevel,
        status: "pending",
        riskLevel,
        isAutonomous: opts?.isAutonomous ?? false,
      },
    });
    await tx.taskSuggestion.update({
      where: { id: suggestionId },
      data: { status: "converted", convertedTaskId: t.id, reviewedAt: new Date() },
    });
    return t;
  });

  await emitAudit({
    entityType: "project",
    entityId: s.projectId,
    eventType: "suggestion.approved",
    actorType: "user",
    payload: { suggestionId, taskId: task.id },
  });

  return { ok: true, taskId: task.id };
}

export async function rejectSuggestion(
  suggestionId: string,
  reviewNote?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await prisma.taskSuggestion.findUnique({ where: { id: suggestionId } });
  if (!s) return { ok: false, error: "Not found" };
  if (s.status !== "pending_review") return { ok: false, error: `Suggestion is already ${s.status}` };

  await prisma.taskSuggestion.update({
    where: { id: suggestionId },
    data: { status: "rejected", reviewNote: reviewNote ?? null, reviewedAt: new Date() },
  });

  await emitAudit({
    entityType: "project",
    entityId: s.projectId,
    eventType: "suggestion.rejected",
    actorType: "user",
    payload: { suggestionId, reviewNote },
  });

  return { ok: true };
}

export async function bulkApproveSuggestions(
  projectId: string,
  ids: string[],
): Promise<{ ok: true; taskIds: string[]; skipped: number } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: false, error: "No ids provided" };

  const suggestions = await prisma.taskSuggestion.findMany({
    where: { id: { in: ids }, projectId, status: "pending_review" },
  });

  const skipped = ids.length - suggestions.length;

  if (suggestions.length === 0) {
    return { ok: true, taskIds: [], skipped };
  }

  const taskIds = await prisma.$transaction(async (tx) => {
    const created: string[] = [];
    for (const s of suggestions) {
      const t = await tx.task.create({
        data: {
          projectId: s.projectId,
          title: s.title,
          description: s.description,
          priority: s.priority,
          taskType: s.taskType,
          estimatedCostLevel: s.estimatedCostLevel,
          status: "pending",
        },
      });
      await tx.taskSuggestion.update({
        where: { id: s.id },
        data: { status: "converted", convertedTaskId: t.id, reviewedAt: new Date() },
      });
      created.push(t.id);
    }
    return created;
  });

  await emitAudit({
    entityType: "project",
    entityId: projectId,
    eventType: "suggestions.bulk_approved",
    actorType: "user",
    payload: { ids, taskIds, count: taskIds.length },
  });

  return { ok: true, taskIds, skipped };
}

export async function bulkRejectSuggestions(
  projectId: string,
  ids: string[],
): Promise<{ ok: true; rejected: number; skipped: number } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: false, error: "No ids provided" };

  const suggestions = await prisma.taskSuggestion.findMany({
    where: { id: { in: ids }, projectId, status: "pending_review" },
  });

  const skipped = ids.length - suggestions.length;
  const rejectable = suggestions.map((s) => s.id);

  if (rejectable.length === 0) {
    return { ok: true, rejected: 0, skipped };
  }

  await prisma.$transaction(async (tx) => {
    await tx.taskSuggestion.updateMany({
      where: { id: { in: rejectable } },
      data: { status: "rejected", reviewedAt: new Date() },
    });
  });

  await emitAudit({
    entityType: "project",
    entityId: projectId,
    eventType: "suggestions.bulk_rejected",
    actorType: "user",
    payload: { ids, count: rejectable.length },
  });

  return { ok: true, rejected: rejectable.length, skipped };
}
