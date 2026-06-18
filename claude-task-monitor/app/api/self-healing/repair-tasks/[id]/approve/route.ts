import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const repairTask = await prisma.repairTask.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!repairTask) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (
      repairTask.status !== "needs_human_review" &&
      repairTask.status !== "failed_validation"
    ) {
      return NextResponse.json(
        { error: `Cannot approve a task with status "${repairTask.status}"` },
        { status: 400 },
      );
    }

    await prisma.repairTask.update({ where: { id }, data: { status: "pending" } });

    return NextResponse.json({
      status: "pending",
      message: "Task approved — queued for the next poller cycle",
    });
  } catch (err) {
    return serverError("[api/self-healing/repair-tasks/approve]", err);
  }
}
