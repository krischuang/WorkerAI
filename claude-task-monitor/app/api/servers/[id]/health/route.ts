import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { checkServerHealth } from "@/lib/worker-health";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({
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
    if (!server) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(server);
  } catch (err) {
    return serverError("servers/[id]/health GET", err);
  }
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await checkServerHealth(id);
    if (!result) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(result);
  } catch (err) {
    return serverError("servers/[id]/health POST", err);
  }
}
