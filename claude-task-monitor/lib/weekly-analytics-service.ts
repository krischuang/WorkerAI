import { prisma } from "@/lib/prisma";

interface PercentileRow {
  avg_ms: string | null;
  p50_ms: string | null;
  p95_ms: string | null;
}

interface CountsRow {
  tasks_completed: string;
  tasks_failed: string;
  tasks_retried: string;
  tasks_timed_out: string;
  tasks_created: string;
  reviews_run: string;
  reviews_passed: string;
  reviews_failed: string;
  worker_recoveries: string;
  dispatch_failures: string;
}

export async function computeWeekAnalytics(weekStart: Date, weekEnd: Date) {
  const [countsRows, percentileRows] = await Promise.all([
    prisma.$queryRaw<CountsRow[]>`
      SELECT
        (SELECT COUNT(*)::text FROM "ExecutionLog"
          WHERE status = 'completed'
            AND "finishedAt" >= ${weekStart} AND "finishedAt" < ${weekEnd}
        ) AS tasks_completed,
        (SELECT COUNT(*)::text FROM "ExecutionLog"
          WHERE status = 'failed'
            AND "finishedAt" >= ${weekStart} AND "finishedAt" < ${weekEnd}
        ) AS tasks_failed,
        (SELECT COUNT(*)::text FROM "Task"
          WHERE "retryCount" > 0
            AND "updatedAt" >= ${weekStart} AND "updatedAt" < ${weekEnd}
        ) AS tasks_retried,
        (SELECT COUNT(*)::text FROM "ExecutionLog"
          WHERE "exitReason" = 'timeout'
            AND "finishedAt" >= ${weekStart} AND "finishedAt" < ${weekEnd}
        ) AS tasks_timed_out,
        (SELECT COUNT(*)::text FROM "Task"
          WHERE "createdAt" >= ${weekStart} AND "createdAt" < ${weekEnd}
        ) AS tasks_created,
        (SELECT COUNT(*)::text FROM "AuditEvent"
          WHERE "eventType" = 'task.review.sent'
            AND "createdAt" >= ${weekStart} AND "createdAt" < ${weekEnd}
        ) AS reviews_run,
        (SELECT COUNT(*)::text FROM "AuditEvent"
          WHERE "eventType" = 'task.review.done'
            AND "createdAt" >= ${weekStart} AND "createdAt" < ${weekEnd}
        ) AS reviews_passed,
        (SELECT COUNT(*)::text FROM "AuditEvent"
          WHERE "eventType" = 'task.review.incomplete'
            AND "createdAt" >= ${weekStart} AND "createdAt" < ${weekEnd}
        ) AS reviews_failed,
        (SELECT COUNT(*)::text FROM "RecoveryLog"
          WHERE "createdAt" >= ${weekStart} AND "createdAt" < ${weekEnd}
        ) AS worker_recoveries,
        (SELECT COUNT(*)::text FROM "ExecutionLog"
          WHERE "failureReason" IN ('ssh_failed', 'tmux_missing')
            AND "finishedAt" >= ${weekStart} AND "finishedAt" < ${weekEnd}
        ) AS dispatch_failures
    `,
    prisma.$queryRaw<PercentileRow[]>`
      SELECT
        AVG("durationMs")::text AS avg_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs")::text AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::text AS p95_ms
      FROM "ExecutionLog"
      WHERE status = 'completed'
        AND "durationMs" IS NOT NULL
        AND "finishedAt" >= ${weekStart}
        AND "finishedAt" < ${weekEnd}
    `,
  ]);

  const c = countsRows[0];
  const p = percentileRows[0];

  function msToMin(ms: string | null): number | null {
    if (!ms) return null;
    const n = parseFloat(ms);
    if (!isFinite(n)) return null;
    return Math.round((n / 60_000) * 10) / 10;
  }

  return {
    weekStart,
    weekEnd,
    tasksCompleted: parseInt(c.tasks_completed, 10),
    tasksFailed: parseInt(c.tasks_failed, 10),
    tasksRetried: parseInt(c.tasks_retried, 10),
    tasksTimedOut: parseInt(c.tasks_timed_out, 10),
    tasksCreated: parseInt(c.tasks_created, 10),
    reviewsRun: parseInt(c.reviews_run, 10),
    reviewsPassed: parseInt(c.reviews_passed, 10),
    reviewsFailed: parseInt(c.reviews_failed, 10),
    avgExecutionMinutes: msToMin(p.avg_ms),
    p50ExecutionMinutes: msToMin(p.p50_ms),
    p95ExecutionMinutes: msToMin(p.p95_ms),
    workerRecoveries: parseInt(c.worker_recoveries, 10),
    dispatchFailures: parseInt(c.dispatch_failures, 10),
  };
}

export async function generateWeeklyAnalytics(weekStart: Date): Promise<object> {
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const data = await computeWeekAnalytics(weekStart, weekEnd);

  return prisma.weeklyAnalytics.upsert({
    where: { weekStart },
    create: data,
    update: {
      weekEnd: data.weekEnd,
      tasksCompleted: data.tasksCompleted,
      tasksFailed: data.tasksFailed,
      tasksRetried: data.tasksRetried,
      tasksTimedOut: data.tasksTimedOut,
      tasksCreated: data.tasksCreated,
      reviewsRun: data.reviewsRun,
      reviewsPassed: data.reviewsPassed,
      reviewsFailed: data.reviewsFailed,
      avgExecutionMinutes: data.avgExecutionMinutes,
      p50ExecutionMinutes: data.p50ExecutionMinutes,
      p95ExecutionMinutes: data.p95ExecutionMinutes,
      workerRecoveries: data.workerRecoveries,
      dispatchFailures: data.dispatchFailures,
    },
  });
}

export function priorWeekStart(now: Date = new Date()): Date {
  // Most recent Monday 00:00 UTC, minus 7 days
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon...
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const thisMonday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToLastMonday)
  );
  return new Date(thisMonday.getTime() - 7 * 86_400_000);
}

export async function weeklyAnalyticsExists(weekStart: Date): Promise<boolean> {
  const existing = await prisma.weeklyAnalytics.findUnique({
    where: { weekStart },
    select: { id: true },
  });
  return existing !== null;
}
