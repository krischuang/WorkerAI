import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { launchClaudeInTmux, type ClaudePermissionMode } from "@/lib/ssh-claude-tmux";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await launchClaudeInTmux(
    { host: server.host, port: server.port, username: server.username, sshKeyPath: server.sshKeyPath },
    server.claudePermissionMode as ClaudePermissionMode
  );

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
