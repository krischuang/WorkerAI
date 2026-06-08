import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { status } = await request.json();

  if (!status) {
    return Response.json({ error: "status is required" }, { status: 400 });
  }

  const task = await prisma.task.update({
    where: { id },
    data: { status },
  });
  return Response.json(task);
}
