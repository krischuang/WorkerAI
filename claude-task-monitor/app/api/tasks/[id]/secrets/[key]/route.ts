import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string; key: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, key } = await ctx.params;
  const deleted = await prisma.taskSecret.deleteMany({
    where: { taskId: id, key },
  });
  if (deleted.count === 0) {
    return NextResponse.json({ error: "Secret not found" }, { status: 404 });
  }

  await emitAudit({
    entityType: "TaskSecret",
    entityId: `${id}:${key}`,
    eventType: "secret.deleted",
    actorType: "user",
    payload: { key },
  });

  return new NextResponse(null, { status: 204 });
}
