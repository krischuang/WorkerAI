import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchClaudeUsageViaTmux } from "@/lib/ssh-claude-tmux";

// tmux: ~5 s check + 2 s wait + ~5 s capture
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) {
    return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
  }

  const result = await fetchClaudeUsageViaTmux({
    host: server.host,
    port: server.port,
    username: server.username,
    sshKeyPath: server.sshKeyPath,
  });

  // Persist to DB on success so the page can show it immediately on next load
  if (result.success) {
    await prisma.server.update({
      where: { id },
      data: {
        claudeSessionPct:      result.parsed.sessionPct ?? null,
        claudeSessionResets:   result.parsed.sessionResets ?? null,
        claudeSessionResetsAt: result.parsed.sessionResetsAt ?? null,
        claudeWeekPct:         result.parsed.weekPct ?? null,
        claudeWeekResets:      result.parsed.weekResets ?? null,
        claudeWeekResetsAt:    result.parsed.weekResetsAt ?? null,
        claudeUsageRaw:        result.rawOutput,
        claudeUsageFetchedAt:  new Date(),
      },
    });
  }

  return NextResponse.json(result);
}
