import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const scans = await prisma.projectScan.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return NextResponse.json(scans);
  } catch (err) {
    return serverError("projects/[id]/scans GET", err);
  }
}
