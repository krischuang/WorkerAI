import { prisma } from "@/lib/prisma";
import { TaskStatus } from "@/app/generated/prisma/client";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

const VALID_STATUSES = new Set<string>(Object.values(TaskStatus));

export async function PUT(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { status } = await request.json();

  if (!status) {
    return Response.json({ error: "status is required" }, { status: 400 });
  }

  if (!VALID_STATUSES.has(status)) {
    return Response.json(
      { error: `Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(", ")}` },
      { status: 400 }
    );
  }

  const task = await prisma.task.update({
    where: { id },
    data: { status: status as TaskStatus },
  });
  return Response.json(task);
}
