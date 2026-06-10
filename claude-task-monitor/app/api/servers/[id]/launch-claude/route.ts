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

    // Kills + relaunches Claude over SSH; cap at 5 per minute per server.
    const rl = apiRateLimit(`server:launch-claude:${id}`, 5, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const result = await launchClaudeInTmux(
      { host: server.host, port: server.port, username: server.username, sshKeyPath: server.sshKeyPath },
      server.claudePermissionMode as ClaudePermissionMode,
      server.tmuxSession,
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return serverError("servers/[id]/launch-claude POST", err);
  }
}
