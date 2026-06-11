import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { startDueImprovementCycles } from "@/lib/improvement-cycle-service";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/:id/trigger-cycle
 * Immediately schedules an improvement cycle for the given project by
 * setting nextImprovementCycleAt to the past, then calls startDueImprovementCycles.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, improvementAutomationLevel: true },
    });
    if (!project) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (project.improvementAutomationLevel < 1) {
      return Response.json(
        { error: "Automation is disabled (level 0). Set improvementAutomationLevel >= 1 first." },
        { status: 400 },
      );
    }

    // Push nextImprovementCycleAt into the past so the project is picked up immediately.
    await prisma.project.update({
      where: { id },
      data: { nextImprovementCycleAt: new Date(Date.now() - 1_000) },
    });

    await startDueImprovementCycles();

    const updated = await prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        improvementAutomationLevel: true,
        nextImprovementCycleAt: true,
        lastImprovementCycleAt: true,
      },
    });

    return Response.json({ triggered: true, project: updated });
  } catch (err) {
    return serverError("projects/[id]/trigger-cycle POST", err);
  }
}
