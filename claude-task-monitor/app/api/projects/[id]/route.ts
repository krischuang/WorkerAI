import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";
import { validateObjectiveUpdate } from "@/lib/project-objective-service";
import { emitAudit } from "@/lib/audit";
import { validateAutomationLevel } from "@/lib/task-validation";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        tasks: {
          include: {
            _count: { select: { executionLogs: true } },
            agent: { select: { id: true, name: true } },
            server: { select: { id: true, name: true } },
          },
          orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
        },
      },
    });
    if (!project) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(project);
  } catch (err) {
    return serverError("projects/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const {
      name, description, priority, status,
      autoReviewEnabled, autoScanEnabled, scanFrequencyDays,
      improvementAutomationLevel, cycleFrequencyDays, nextImprovementCycleAt,
      resetImprovementPause,
      repoUrl, defaultBranch, workspaceStrategy,
      objective, successCriteria, constraints, nonGoals, improvementFocus,
      autonomousMode, allowHighRiskAutonomy,
    } = body;

    const validationErr = validateObjectiveUpdate({ objective, successCriteria, constraints, nonGoals, improvementFocus, autonomousMode });
    if (validationErr) {
      return Response.json({ error: validationErr }, { status: 400 });
    }

    const autonomousModeErr = validateAutomationLevel(autonomousMode, "autonomousMode");
    if (autonomousModeErr) {
      return Response.json({ error: autonomousModeErr.message }, { status: 400 });
    }

    const improvementAutomationLevelErr = validateAutomationLevel(improvementAutomationLevel, "improvementAutomationLevel");
    if (improvementAutomationLevelErr) {
      return Response.json({ error: improvementAutomationLevelErr.message }, { status: 400 });
    }

    const editsObjectiveFields = [objective, successCriteria, constraints, nonGoals, improvementFocus].some((v) => v !== undefined);

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(priority !== undefined && { priority }),
        ...(status !== undefined && { status }),
        ...(autoReviewEnabled !== undefined && { autoReviewEnabled: Boolean(autoReviewEnabled) }),
        ...(autoScanEnabled !== undefined && { autoScanEnabled: Boolean(autoScanEnabled) }),
        ...(scanFrequencyDays !== undefined && { scanFrequencyDays: Number(scanFrequencyDays) }),
        ...(improvementAutomationLevel !== undefined && {
          improvementAutomationLevel: Math.max(0, Math.min(3, Number(improvementAutomationLevel))),
        }),
        ...(cycleFrequencyDays !== undefined && {
          cycleFrequencyDays: Math.max(1, Number(cycleFrequencyDays)),
        }),
        ...(nextImprovementCycleAt !== undefined && {
          nextImprovementCycleAt: nextImprovementCycleAt === null ? null : new Date(nextImprovementCycleAt),
        }),
        ...(resetImprovementPause === true && {
          autoImprovementPaused: false,
          scanFailureCount: 0,
        }),
        // Remote-first repository fields
        ...(repoUrl !== undefined && { repoUrl: repoUrl === null ? null : String(repoUrl) }),
        ...(defaultBranch !== undefined && { defaultBranch: String(defaultBranch) }),
        ...(workspaceStrategy !== undefined && { workspaceStrategy }),
        // Project Objective — Claude-drafted, admin-editable. All content must be English.
        ...(objective !== undefined && { objective }),
        ...(successCriteria !== undefined && { successCriteria }),
        ...(constraints !== undefined && { constraints }),
        ...(nonGoals !== undefined && { nonGoals }),
        ...(improvementFocus !== undefined && { improvementFocus }),
        ...(editsObjectiveFields && { lastObjectiveUpdatedAt: new Date() }),
        // Autonomous execution mode (0-4) — see lib/task-service.ts's autoAssignQueuedTasks.
        ...(autonomousMode !== undefined && { autonomousMode: Number(autonomousMode) }),
        ...(allowHighRiskAutonomy !== undefined && { allowHighRiskAutonomy: Boolean(allowHighRiskAutonomy) }),
      },
    });

    if (editsObjectiveFields) {
      await emitAudit({
        entityType: "project",
        entityId: id,
        eventType: "project.objective.updated",
        actorType: "user",
        payload: { fields: Object.fromEntries(Object.entries({ objective, successCriteria, constraints, nonGoals, improvementFocus }).filter(([, v]) => v !== undefined)) },
      });
    }
    if (autonomousMode !== undefined || allowHighRiskAutonomy !== undefined) {
      await emitAudit({
        entityType: "project",
        entityId: id,
        eventType: "project.autonomous_mode_changed",
        actorType: "user",
        payload: { autonomousMode, allowHighRiskAutonomy },
      });
    }

    return Response.json(project);
  } catch (err) {
    return serverError("projects/[id] PUT", err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const project = await prisma.project.findUnique({
      where: { id },
      select: { name: true, status: true },
    });
    await prisma.project.delete({ where: { id } });
    await emitAudit({
      entityType: "project",
      entityId: id,
      eventType: "project.deleted",
      actorType: "user",
      payload: { name: project?.name, status: project?.status },
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("projects/[id] DELETE", err);
  }
}
