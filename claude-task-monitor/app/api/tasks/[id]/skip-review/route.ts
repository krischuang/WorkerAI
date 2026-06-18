import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { emitAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const task = await prisma.task.findUnique({ where: { id }, select: { id: true, reviewStatus: true } });
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    if (task.reviewStatus == null) {
      return NextResponse.json({ error: "Task has no pending review" }, { status: 400 });
    }

    const previousStatus = task.reviewStatus;

    const updated = await prisma.task.update({
      where: { id },
      data: { reviewStatus: "skipped", reviewCompletedAt: new Date() },
    });

    emitAudit({ entityType: "Task", entityId: id, eventType: "task.review_skipped", actorType: "user", payload: { previousStatus, newStatus: "skipped" } }).catch(() => {});

    return NextResponse.json({ id: updated.id, reviewStatus: updated.reviewStatus });
  } catch (err) {
    return serverError("tasks/[id]/skip-review POST", err);
  }
}
