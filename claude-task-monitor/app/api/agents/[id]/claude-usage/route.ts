import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchClaudeUsageReliable } from "@/lib/ssh-claude-tmux";
import { recordUsageSnapshot } from "@/lib/usage-snapshot-service";
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
        cleanedOutput: "",
        parsed: {},
        error: "Agent has no tmuxSession configured.",
      });
    }

    const s = agent.server;
    const result = await fetchClaudeUsageReliable(
      { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
      agent.tmuxSession,
      "manual_refresh",
    );

    // Always store a snapshot — even on failure or low confidence, so history is preserved.
    // Agent.claudeSessionPct/claudeWeekPct are only touched when confidence is high/medium —
    // see lib/usage-snapshot-service.ts for the full rule.
    const { snapshotId, agentUpdated } = await recordUsageSnapshot(id, result, "manual_refresh");

    if (result.success) {
      await prisma.agent.update({ where: { id }, data: { status: "idle" } }).catch(() => {});
    }

    return NextResponse.json({ ...result, agentUpdated, snapshot: { id: snapshotId } });
  } catch (err) {
    return serverError("agents/[id]/claude-usage POST", err);
  }
}
