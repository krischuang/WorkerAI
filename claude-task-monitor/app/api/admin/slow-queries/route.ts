import { getSlowQueryLog } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

/**
 * GET /api/admin/slow-queries
 * Returns up to 10 slowest queries from the in-memory circular buffer,
 * sorted by duration descending.
 */
export async function GET() {
  try {
    const top10 = getSlowQueryLog().slice(0, 10);
    return Response.json(top10);
  } catch (err) {
    return serverError("admin/slow-queries GET", err);
  }
}
