import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const tasks = await prisma.repairTask.findMany({
      include: {
        incident: {
          select: {
            id: true,
            source: true,
            severity: true,
            status: true,
            title: true,
            createdAt: true,
          },
        },
        assignedAgent: { select: { id: true, name: true, slug: true } },
        repairAttempts: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        auditLogs: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return NextResponse.json(tasks);
  } catch (err) {
    return serverError("[api/self-healing/repair-tasks]", err);
  }
}
