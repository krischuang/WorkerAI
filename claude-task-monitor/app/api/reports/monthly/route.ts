import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { generateMonthlyReport, firstOfMonth } from "@/lib/monthly-report-service";

export async function GET() {
  try {
    const reports = await prisma.monthlyReport.findMany({
      orderBy: { monthStart: "desc" },
      take: 24, // 2 years
    });
    return Response.json(reports);
  } catch (err) {
    return serverError("reports/monthly GET", err);
  }
}

export async function POST() {
  try {
    const monthStart = firstOfMonth(new Date());
    const report = await generateMonthlyReport(monthStart, "manual");
    return Response.json(report, { status: 201 });
  } catch (err) {
    return serverError("reports/monthly POST", err);
  }
}
