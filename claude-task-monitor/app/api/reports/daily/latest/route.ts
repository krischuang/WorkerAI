import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const report = await prisma.dailyReport.findFirst({
      orderBy: { date: "desc" },
    });
    if (!report) return Response.json(null);
    return Response.json(report);
  } catch (err) {
    return serverError("reports/daily/latest GET", err);
  }
}
