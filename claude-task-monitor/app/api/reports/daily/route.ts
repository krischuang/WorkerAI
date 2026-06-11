import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { generateDailyReport } from "@/lib/daily-report-service";

export async function GET() {
  try {
    const reports = await prisma.dailyReport.findMany({
      orderBy: { date: "desc" },
      take: 30,
    });
    return Response.json(reports);
  } catch (err) {
    return serverError("reports/daily GET", err);
  }
}

export async function POST() {
  try {
    const report = await generateDailyReport("manual");
    return Response.json(report, { status: 201 });
  } catch (err) {
    return serverError("reports/daily POST", err);
  }
}
