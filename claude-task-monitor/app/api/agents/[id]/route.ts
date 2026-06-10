import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

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
    const { name, workDir, tmuxSession, status, claudePermissionMode } = body;

    const agent = await prisma.agent.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(workDir !== undefined && { workDir }),
        ...(tmuxSession !== undefined && { tmuxSession }),
        ...(status !== undefined && { status }),
        ...(claudePermissionMode !== undefined && { claudePermissionMode }),
      },
      include: AGENT_INCLUDE,
    });

    return NextResponse.json(agent);
  } catch (err) {
    return serverError("agents/[id] PUT", err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await prisma.agent.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    return serverError("agents/[id] DELETE", err);
  }
}
