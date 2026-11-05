import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { computeAgentReliability } from "@/lib/agent-reliability";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Read-only. Returns the Adaptive Trust Engine's deterministic,
 * evidence-based reliability signal for this agent — see
 * lib/agent-reliability.ts. No side effects, no dispatch decisions.
 * Optional ?taskType= query param scopes the computation to one task type.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
    if (!agent) return Response.json({ error: "Not found" }, { status: 404 });

    const taskType = req.nextUrl.searchParams.get("taskType") ?? undefined;
    const result = await computeAgentReliability(id, taskType ? { taskType } : undefined);
    return Response.json(result);
  } catch (err) {
    return serverError("agents/[id]/reliability GET", err);
  }
}
