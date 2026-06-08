import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const logs = await prisma.serverCommandLog.findMany({
    where: { serverId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return Response.json(logs);
}
