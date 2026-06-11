import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const server = await prisma.server.findUnique({ where: { id }, select: { id: true } });
    if (!server) return Response.json({ error: "Not found" }, { status: 404 });

    await prisma.server.update({
      where: { id },
      data: { pausedDueToUsage: false, pausedAt: null },
    });

    // Mark any pending scheduled resume as triggered so it doesn't re-fire.
    await prisma.scheduledResume.updateMany({
      where: { resourceType: "server", resourceId: id, triggered: false },
      data: { triggered: true },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError("servers/[id]/resume POST", err);
  }
}
