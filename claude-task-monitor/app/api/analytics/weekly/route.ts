import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { generateWeeklyAnalytics, priorWeekStart } from "@/lib/weekly-analytics-service";

export async function GET() {
  try {
    const rows = await prisma.weeklyAnalytics.findMany({
      orderBy: { weekStart: "desc" },
      take: 12,
    });
    return Response.json(rows);
  } catch (err) {
    return serverError("analytics/weekly GET", err);
  }
}

export async function POST() {
  try {
    const weekStart = priorWeekStart();
    const record = await generateWeeklyAnalytics(weekStart);
    return Response.json(record, { status: 201 });
  } catch (err) {
    return serverError("analytics/weekly POST", err);
  }
}
