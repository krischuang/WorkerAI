import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchClaudeUsageViaTmux } from "@/lib/ssh-claude-tmux";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  const agent = await prisma.agent.findUnique({
    where: { id },
    include: { server: true },
  });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const s = agent.server;
  const result = await fetchClaudeUsageViaTmux(
    { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
    agent.tmuxSession,
  );

  if (result.success) {
    await prisma.agent.update({
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
        status:                "idle",
      },
    });
  }

  return NextResponse.json(result);
}
