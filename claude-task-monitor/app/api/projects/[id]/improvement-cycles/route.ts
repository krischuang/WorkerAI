import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/projects/[id]/improvement-cycles — list cycles for a project */
export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const cycles = await prisma.improvementCycle.findMany({
      where: { projectId: id },
      orderBy: { startedAt: "desc" },
      take: 20,
    });

    return NextResponse.json(cycles);
  } catch (err) {
    return serverError("projects/[id]/improvement-cycles GET", err);
  }
}
