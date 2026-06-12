import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

/** GET /api/admin/audit-log — last 200 admin action entries, newest first. */
export async function GET() {
  try {
    const entries = await prisma.adminAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return Response.json(entries);
  } catch (err) {
    return serverError("admin/audit-log GET", err);
  }
}
