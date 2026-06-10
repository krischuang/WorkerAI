import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchClaudeUsageViaTmux } from "@/lib/ssh-claude-tmux";
import { serverError } from "@/lib/api-error";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // Each call opens an SSH connection and takes ~12 s; cap at 6 per minute per agent.
    const rl = apiRateLimit(`agent:claude-usage:${id}`, 6, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const agent = await prisma.agent.findUnique({
      where: { id },
      include: { server: true },
    });
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (!agent.tmuxSession || !agent.tmuxSession.trim()) {
      return NextResponse.json({
        success: false,
        status: "offline",
        rawOutput: "",
        parsed: {},
        error: "Agent has no tmuxSession configured.",
      });
    }

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
          claudeUsageRaw:        result.rawOutput.slice(0, 500),
          claudeUsageFetchedAt:  new Date(),
          status:                "idle",
        },
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    return serverError("agents/[id]/claude-usage POST", err);
  }
}
