import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        tasks: {
          include: { _count: { select: { executionLogs: true } } },
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
    } = body;

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
      },
    });
    return Response.json(project);
  } catch (err) {
    return serverError("projects/[id] PUT", err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await prisma.project.delete({ where: { id } });
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("projects/[id] DELETE", err);
  }
}
