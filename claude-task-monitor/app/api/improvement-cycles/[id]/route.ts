import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/improvement-cycles/[id] — get a single cycle */
export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const cycle = await prisma.improvementCycle.findUnique({
      where: { id },
      include: { project: { select: { id: true, name: true } } },
    });

    if (!cycle) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(cycle);
  } catch (err) {
    return serverError("improvement-cycles/[id] GET", err);
  }
}
