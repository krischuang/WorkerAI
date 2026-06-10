import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { launchClaudeInTmux, type ClaudePermissionMode } from "@/lib/ssh-claude-tmux";
import { serverError } from "@/lib/api-error";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // Kills + relaunches Claude over SSH; cap at 5 per minute per agent.
    const rl = apiRateLimit(`agent:launch-claude:${id}`, 5, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const agent = await prisma.agent.findUnique({
      where: { id },
      include: { server: true },
    });
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const s = agent.server;
    const result = await launchClaudeInTmux(
      { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
      agent.claudePermissionMode as ClaudePermissionMode,
      agent.tmuxSession,
      agent.workDir,
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    await prisma.agent.update({ where: { id }, data: { status: "idle" } });

    return NextResponse.json({ success: true, command: result.command });
  } catch (err) {
    return serverError("agents/[id]/launch-claude POST", err);
  }
}
