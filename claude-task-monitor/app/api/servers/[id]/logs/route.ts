import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);

  const cursor = searchParams.get("cursor") ?? undefined;
  const limit = Math.min(
    Math.max(Number(searchParams.get("limit") ?? DEFAULT_LIMIT), 1),
    MAX_LIMIT
  );

  // Fetch one extra row to detect whether a next page exists.
  const items = await prisma.serverCommandLog.findMany({
    where: { serverId: id },
    orderBy: { createdAt: "desc" },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
  });

  const hasNext = items.length > limit;
  const logs = hasNext ? items.slice(0, limit) : items;

  return Response.json({
    logs,
    nextCursor: hasNext ? logs[logs.length - 1].id : null,
  });
}
