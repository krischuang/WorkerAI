import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { generateWeeklyReport, mondayOfWeek } from "@/lib/weekly-report-service";

export async function GET() {
  try {
    const reports = await prisma.weeklyReport.findMany({
      orderBy: { weekStart: "desc" },
      take: 26, // ~6 months
    });
    return Response.json(reports);
  } catch (err) {
    return serverError("reports/weekly GET", err);
  }
}

export async function POST() {
  try {
    const weekStart = mondayOfWeek(new Date());
    const report = await generateWeeklyReport(weekStart, "manual");
    return Response.json(report, { status: 201 });
  } catch (err) {
    return serverError("reports/weekly POST", err);
  }
}
