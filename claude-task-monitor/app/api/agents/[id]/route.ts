import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { jsonResponse } from "@/lib/json-response";
import { logAdminAction } from "@/lib/admin-audit-log";
import { validateTmuxSession, validateWorkDir } from "@/lib/task-validation";
import { sanitizeAgentServer } from "@/lib/sanitize-response";

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
    return jsonResponse(sanitizeAgentServer(agent));
  } catch (err) {
    return serverError("agents/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const { name, workDir, tmuxSession, claudePermissionMode, maxConcurrentTasks, tags } = body;

    if (maxConcurrentTasks !== undefined) {
      const n = Number(maxConcurrentTasks);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return NextResponse.json({ error: "maxConcurrentTasks must be an integer between 1 and 5" }, { status: 400 });
      }
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.trim() === "")) {
        return NextResponse.json({ error: "tags must be an array of non-empty strings" }, { status: 400 });
      }
    }

    if (tmuxSession !== undefined) {
      const tmuxErr = validateTmuxSession(tmuxSession);
      if (tmuxErr) return NextResponse.json({ error: tmuxErr.message }, { status: 400 });
    }

    if (workDir !== undefined) {
      const workDirErr = validateWorkDir(workDir);
      if (workDirErr) return NextResponse.json({ error: workDirErr.message }, { status: 400 });
    }

    const agent = await prisma.agent.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(workDir !== undefined && { workDir }),
        ...(tmuxSession !== undefined && { tmuxSession }),
        ...(claudePermissionMode !== undefined && { claudePermissionMode }),
        ...(maxConcurrentTasks !== undefined && { maxConcurrentTasks: Number(maxConcurrentTasks) }),
        ...(tags !== undefined && { tags: (tags as string[]).map((t) => t.trim().toLowerCase()) }),
      },
      include: AGENT_INCLUDE,
    });

    const changedFields = Object.fromEntries(
      Object.entries({ name, workDir, tmuxSession, claudePermissionMode, maxConcurrentTasks, tags })
        .filter(([, v]) => v !== undefined),
    );
    await logAdminAction(request, {
      action: "agent.updated",
      targetType: "Agent",
      targetId: id,
      payload: { fields: changedFields },
    });

    return jsonResponse(sanitizeAgentServer(agent));
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
