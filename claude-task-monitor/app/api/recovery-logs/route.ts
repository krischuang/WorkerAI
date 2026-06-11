import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const serverId = searchParams.get("serverId");
    const agentId = searchParams.get("agentId");
    const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 200);

    const logs = await prisma.recoveryLog.findMany({
      where: {
        ...(serverId && { serverId }),
        ...(agentId && { agentId }),
      },
      include: {
        server: { select: { id: true, name: true } },
        agent: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return Response.json(logs);
  } catch (err) {
    return serverError("recovery-logs GET", err);
  }
}
