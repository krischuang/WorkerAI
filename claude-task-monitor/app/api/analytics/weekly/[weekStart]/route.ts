import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ weekStart: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { weekStart } = await ctx.params;
    const date = new Date(weekStart);
    if (isNaN(date.getTime())) {
      return Response.json({ error: "Invalid weekStart date" }, { status: 400 });
    }
    const record = await prisma.weeklyAnalytics.findUnique({
      where: { weekStart: date },
    });
    if (!record) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(record);
  } catch (err) {
    return serverError("analytics/weekly/[weekStart] GET", err);
  }
}
