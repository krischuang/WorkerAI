import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { getProjectVelocity } from "@/lib/project-progress";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exists = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return Response.json({ error: "Not found" }, { status: 404 });

    const velocity = await getProjectVelocity(id);
    return Response.json(velocity);
  } catch (err) {
    return serverError("projects/[id]/velocity GET", err);
  }
}
