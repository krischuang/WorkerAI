import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const since = new Date(Date.now() - 30 * 86_400_000);

    const rows = await prisma.weeklyAnalytics.findMany({
      where: { weekStart: { gte: since } },
      orderBy: { weekStart: "asc" },
    });

    if (rows.length === 0) {
      return Response.json({
        totalCompleted: 0,
        totalFailed: 0,
        totalCreated: 0,
        totalTimedOut: 0,
        totalRetried: 0,
        totalReviewsRun: 0,
        totalReviewsPassed: 0,
        totalReviewsFailed: 0,
        totalWorkerRecoveries: 0,
        totalDispatchFailures: 0,
        avgExecutionMinutes: null,
        p50ExecutionMinutes: null,
        p95ExecutionMinutes: null,
        completionRate: null,
        reviewPassRate: null,
      });
    }

    const totals = rows.reduce(
      (acc, r) => ({
        totalCompleted: acc.totalCompleted + r.tasksCompleted,
        totalFailed: acc.totalFailed + r.tasksFailed,
        totalCreated: acc.totalCreated + r.tasksCreated,
        totalTimedOut: acc.totalTimedOut + r.tasksTimedOut,
        totalRetried: acc.totalRetried + r.tasksRetried,
        totalReviewsRun: acc.totalReviewsRun + r.reviewsRun,
        totalReviewsPassed: acc.totalReviewsPassed + r.reviewsPassed,
        totalReviewsFailed: acc.totalReviewsFailed + r.reviewsFailed,
        totalWorkerRecoveries: acc.totalWorkerRecoveries + r.workerRecoveries,
        totalDispatchFailures: acc.totalDispatchFailures + r.dispatchFailures,
      }),
      {
        totalCompleted: 0,
        totalFailed: 0,
        totalCreated: 0,
        totalTimedOut: 0,
        totalRetried: 0,
        totalReviewsRun: 0,
        totalReviewsPassed: 0,
        totalReviewsFailed: 0,
        totalWorkerRecoveries: 0,
        totalDispatchFailures: 0,
      }
    );

    const avgRows = rows.filter((r) => r.avgExecutionMinutes != null);
    const avgExecutionMinutes =
      avgRows.length > 0
        ? Math.round((avgRows.reduce((s, r) => s + r.avgExecutionMinutes!, 0) / avgRows.length) * 10) / 10
        : null;

    const p50Rows = rows.filter((r) => r.p50ExecutionMinutes != null);
    const p50ExecutionMinutes =
      p50Rows.length > 0
        ? Math.round((p50Rows.reduce((s, r) => s + r.p50ExecutionMinutes!, 0) / p50Rows.length) * 10) / 10
        : null;

    const p95Rows = rows.filter((r) => r.p95ExecutionMinutes != null);
    const p95ExecutionMinutes =
      p95Rows.length > 0
        ? Math.round((p95Rows.reduce((s, r) => s + r.p95ExecutionMinutes!, 0) / p95Rows.length) * 10) / 10
        : null;

    const completionBase = totals.totalCompleted + totals.totalFailed;
    const completionRate =
      completionBase > 0 ? Math.round((totals.totalCompleted / completionBase) * 1000) / 10 : null;

    const reviewPassRate =
      totals.totalReviewsRun > 0
        ? Math.round((totals.totalReviewsPassed / totals.totalReviewsRun) * 1000) / 10
        : null;

    return Response.json({
      ...totals,
      avgExecutionMinutes,
      p50ExecutionMinutes,
      p95ExecutionMinutes,
      completionRate,
      reviewPassRate,
    });
  } catch (err) {
    return serverError("analytics/summary GET", err);
  }
}
