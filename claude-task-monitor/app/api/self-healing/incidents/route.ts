import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const incidents = await prisma.incident.findMany({
      include: {
        affectedAgent: { select: { id: true, name: true, slug: true } },
        repairTasks: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, riskLevel: true, title: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return NextResponse.json(incidents);
  } catch (err) {
    return serverError("[api/self-healing/incidents]", err);
  }
}
