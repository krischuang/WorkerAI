import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { checkAgentHealth } from "@/lib/worker-health";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const agent = await prisma.agent.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        healthScore: true,
        consecutiveFailures: true,
        lastHealthCheckAt: true,
        workerHealths: {
          orderBy: { checkedAt: "desc" },
          take: 48,
        },
      },
    });
    if (!agent) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(agent);
  } catch (err) {
    return serverError("agents/[id]/health GET", err);
  }
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await checkAgentHealth(id);
    if (!result) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(result);
  } catch (err) {
    return serverError("agents/[id]/health POST", err);
  }
}
