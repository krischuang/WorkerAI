import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const severity = searchParams.get("severity");
    const projectId = searchParams.get("projectId");
    const category = searchParams.get("category");

    const items = await prisma.debtItem.findMany({
      where: {
        ...(projectId && { projectId }),
        ...(status && { status: status as never }),
        ...(severity && { severity: severity as never }),
        ...(category && { category: category as never }),
      },
      include: { project: { select: { id: true, name: true } } },
      orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
      take: 200,
    });

    return NextResponse.json(items);
  } catch (err) {
    return serverError("debt GET", err);
  }
}
