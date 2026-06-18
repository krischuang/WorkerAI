import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { emitAudit } from "@/lib/audit";
import { validateAutomationLevel } from "@/lib/task-validation";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/projects/[id]/improvement-cycle — manually start a new cycle */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const rawLevel = body.automationLevel;
    const levelErr = validateAutomationLevel(rawLevel);
    if (levelErr) return NextResponse.json({ error: levelErr.message }, { status: 400 });
    const automationLevel: number | undefined = rawLevel !== undefined && rawLevel !== null
      ? Number(rawLevel)
      : undefined;

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, name: true, improvementAutomationLevel: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const active = await prisma.improvementCycle.count({
      where: { projectId: id, status: { notIn: ["completed", "cancelled", "failed"] } },
    });
    if (active > 0) {
      return NextResponse.json({ error: "A cycle is already in progress for this project" }, { status: 409 });
    }

    const level = automationLevel ?? project.improvementAutomationLevel;
    const cycle = await prisma.improvementCycle.create({
      data: {
        projectId: id,
        automationLevel: level,
        status: "idle",
        startedAt: new Date(),
      },
    });

    await emitAudit({
      entityType: "project",
      entityId: id,
      eventType: "improvement_cycle.started",
      actorType: "user",
      payload: { cycleId: cycle.id, automationLevel: level },
    });

    return NextResponse.json(cycle, { status: 201 });
  } catch (err) {
    return serverError("projects/[id]/improvement-cycle POST", err);
  }
}
