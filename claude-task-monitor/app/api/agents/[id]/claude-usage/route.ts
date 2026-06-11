import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchClaudeUsageViaPipePaneTmux } from "@/lib/ssh-claude-tmux";
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
    const result = await fetchClaudeUsageViaPipePaneTmux(
      { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
      agent.tmuxSession,
    );

    // Always store a snapshot — even on failure, so history is preserved.
    // Never interpret null usagePercent as 0%.
    const snapshot = await prisma.agentUsageSnapshot.create({
      data: {
        agentId:            id,
        usagePercent:       result.success ? (result.parsed.weekPct ?? null) : null,
        resetTime:          result.success ? (result.parsed.weekResets ?? null) : null,
        resetAt:            result.success ? (result.parsed.weekResetsAt ?? null) : null,
        usageCreditsEnabled: result.success ? (result.parsed.usageCreditsEnabled ?? null) : null,
        captureStatus:      result.status,
        rawOutput:          result.rawOutput.slice(0, 2000) || null,
        cleanedOutput:      result.cleanedOutput.slice(0, 2000) || null,
      },
    });

    // Only update the Agent's cached usage fields on a successful capture.
    // A failed refresh must NOT overwrite valid data with nulls.
    if (result.success) {
      await prisma.agent.update({
        where: { id },
        data: {
          claudeSessionPct:           result.parsed.sessionPct ?? null,
          claudeSessionResets:        result.parsed.sessionResets ?? null,
          claudeSessionResetsAt:      result.parsed.sessionResetsAt ?? null,
          claudeWeekPct:              result.parsed.weekPct ?? null,
          claudeWeekResets:           result.parsed.weekResets ?? null,
          claudeWeekResetsAt:         result.parsed.weekResetsAt ?? null,
          claudeUsageRaw:             result.rawOutput.slice(0, 500),
          claudeUsageFetchedAt:       new Date(),
          claudeUsageCreditsEnabled:  result.parsed.usageCreditsEnabled ?? null,
          claudeLastRefreshStatus:    result.status,
          status:                     "idle",
        },
      });
    } else {
      // Record that the last refresh failed without clearing usage data.
      await prisma.agent.update({
        where: { id },
        data: { claudeLastRefreshStatus: result.status },
      });
    }

    return NextResponse.json({ ...result, snapshot: { id: snapshot.id, captureStatus: snapshot.captureStatus, capturedAt: snapshot.capturedAt } });
  } catch (err) {
    return serverError("agents/[id]/claude-usage POST", err);
  }
}
