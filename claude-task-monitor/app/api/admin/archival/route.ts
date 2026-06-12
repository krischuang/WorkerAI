import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { archiveOldLogs } from "@/lib/execution-log-archival";
import { logAdminAction } from "@/lib/admin-audit-log";
import type { NextRequest } from "next/server";

/**
 * GET /api/admin/archival
 * Returns storage stats: unarchived log count before the current cutoff,
 * oldest unarchived finishedAt date, and current retention setting.
 */
export async function GET() {
  try {
    const cfg = await prisma.systemConfig.findUnique({
      where: { key: "execution_log_retention_days" },
      select: { value: true },
    });

    let retentionDays = 90;
    if (cfg) {
      const parsed = parseInt(cfg.value, 10);
      if (!isNaN(parsed) && parsed > 0) retentionDays = parsed;
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const [eligibleCount, oldest] = await Promise.all([
      prisma.executionLog.count({
        where: { finishedAt: { lt: cutoff }, archivedAt: null },
      }),
      prisma.executionLog.findFirst({
        where: { archivedAt: null, finishedAt: { not: null } },
        orderBy: { finishedAt: "asc" },
        select: { finishedAt: true },
      }),
    ]);

    return Response.json({
      retentionDays,
      cutoff: cutoff.toISOString(),
      eligibleCount,
      oldestUnarchivedAt: oldest?.finishedAt?.toISOString() ?? null,
    });
  } catch (err) {
    return serverError("admin/archival GET", err);
  }
}

/**
 * POST /api/admin/archival
 * Runs archiveOldLogs() on-demand and returns { archived: number }.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await archiveOldLogs();
    await logAdminAction(request, {
      action: "archival.triggered",
      targetType: "ExecutionLog",
      payload: { archived: result.archived },
    });
    return Response.json(result);
  } catch (err) {
    return serverError("admin/archival POST", err);
  }
}
