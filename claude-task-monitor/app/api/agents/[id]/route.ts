import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { logAdminAction } from "@/lib/admin-audit-log";

type Ctx = { params: Promise<{ id: string }> };

const AGENT_INCLUDE = {
  server: { select: { id: true, name: true, host: true, username: true, port: true, sshKeyPath: true } },
  _count: { select: { tasks: true } },
} as const;

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const agent = await prisma.agent.findUnique({ where: { id }, include: AGENT_INCLUDE });
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(agent);
  } catch (err) {
    return serverError("agents/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const { name, workDir, tmuxSession, status, claudePermissionMode, maxConcurrentTasks } = body;

    if (maxConcurrentTasks !== undefined) {
      const n = Number(maxConcurrentTasks);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return NextResponse.json({ error: "maxConcurrentTasks must be an integer between 1 and 5" }, { status: 400 });
      }
    }

    const agent = await prisma.agent.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(workDir !== undefined && { workDir }),
        ...(tmuxSession !== undefined && { tmuxSession }),
        ...(status !== undefined && { status }),
        ...(claudePermissionMode !== undefined && { claudePermissionMode }),
        ...(maxConcurrentTasks !== undefined && { maxConcurrentTasks: Number(maxConcurrentTasks) }),
      },
      include: AGENT_INCLUDE,
    });

    const changedFields = Object.fromEntries(
      Object.entries({ name, workDir, tmuxSession, status, claudePermissionMode, maxConcurrentTasks })
        .filter(([, v]) => v !== undefined),
    );
    await logAdminAction(request, {
      action: "agent.updated",
      targetType: "Agent",
      targetId: id,
      payload: { fields: changedFields },
    });

    return NextResponse.json(agent);
  } catch (err) {
    return serverError("agents/[id] PUT", err);
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const agent = await prisma.agent.findUnique({ where: { id }, select: { name: true } });
    await prisma.agent.delete({ where: { id } });
    await logAdminAction(request, {
      action: "agent.deleted",
      targetType: "Agent",
      targetId: id,
      payload: { name: agent?.name },
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return serverError("agents/[id] DELETE", err);
  }
}
