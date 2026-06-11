import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ date: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { date } = await ctx.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const report = await prisma.dailyReport.findFirst({
      where: { date: { gte: dayStart, lt: dayEnd } },
      orderBy: { date: "desc" },
    });
    if (!report) return Response.json(null, { status: 404 });
    return Response.json(report);
  } catch (err) {
    return serverError("reports/daily/[date] GET", err);
  }
}
