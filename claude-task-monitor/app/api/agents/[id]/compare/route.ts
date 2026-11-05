import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { compareBaselineWithEvidencePreference } from "@/lib/adaptive-trust";
import type { AgentCandidate } from "@/lib/agent-selector";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Read-only. Compares the baseline (capability/health/load) pick against
 * an evidence-preferred alternative — among THIS agent and its eligible
 * siblings on the same server — for a given task type. No side effects,
 * no dispatch decisions. Optional ?taskType= (default "coding").
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const agent = await prisma.agent.findUnique({ where: { id }, select: { serverId: true } });
    if (!agent) return Response.json({ error: "Not found" }, { status: 404 });

    const taskType = req.nextUrl.searchParams.get("taskType") ?? "coding";

    const siblings = await prisma.agent.findMany({
      where: { serverId: agent.serverId },
      select: {
        id: true, name: true, tags: true, status: true, healthScore: true,
        activeTaskCount: true, maxConcurrentTasks: true,
        claudeSessionPct: true, claudeWeekPct: true, pausedDueToUsage: true, cooldownUntil: true,
      },
    });

    const candidates: AgentCandidate[] = siblings.map((a) => ({
      id: a.id,
      name: a.name,
      tags: a.tags,
      status: a.status,
      healthScore: a.healthScore,
      activeTaskCount: a.activeTaskCount,
      maxConcurrentTasks: a.maxConcurrentTasks,
      claudeSessionPct: a.claudeSessionPct,
      claudeWeekPct: a.claudeWeekPct,
      pausedDueToUsage: a.pausedDueToUsage,
      cooldownUntil: a.cooldownUntil,
    }));

    const result = await compareBaselineWithEvidencePreference(candidates, { requiredTags: [], taskType });

    // Enriched with display names for the UI only — the core advisory
    // function itself returns ids, which is what tests and other callers
    // (e.g. the demo scripts) key off; this route adds names on top purely
    // so the Agent Detail page doesn't have to show a raw id string.
    const nameOf = (agentId: string | null) => (agentId ? siblings.find((a) => a.id === agentId)?.name ?? agentId : null);
    return Response.json({
      ...result,
      baselineAgentName: nameOf(result.baselineAgentId),
      evidencePreferredAgentName: nameOf(result.evidencePreferredAgentId),
    });
  } catch (err) {
    return serverError("agents/[id]/compare GET", err);
  }
}
