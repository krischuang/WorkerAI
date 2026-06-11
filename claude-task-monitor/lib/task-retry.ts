/**
 * Task retry engine.
 *
 * After a task fails at runtime, evaluateRetry() checks whether the task is
 * eligible for a retry attempt. If so, it resets the task back to "queued"
 * with a retryAfter timestamp that throttles the next dispatch attempt.
 *
 * Delay schedule (based on the attempt index before the increment):
 *   0 → 1 : 2 min
 *   1 → 2 : 5 min
 *   2+    : 10 min (capped)
 *
 * Non-retryable reasons: if the failure reason indicates a configuration
 * problem (no resource assigned, task is not dispatchable) retrying
 * immediately would fail again — skip it.
 */

import { prisma } from "@/lib/prisma";

const RETRY_DELAYS_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];

const NON_RETRYABLE_REASONS = new Set(["task_not_dispatchable", "no_resource"]);

/**
 * Evaluate whether a just-failed task should be retried.
 *
 * Returns true if a retry was scheduled (task reset to "queued" with
 * retryAfter set), false if the task is not eligible.
 */
export async function evaluateRetry(
  taskId: string,
  failureReason?: string,
): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { retryCount: true, maxRetries: true },
  });

  if (!task) return false;
  if (task.maxRetries <= 0) return false;
  if (task.retryCount >= task.maxRetries) return false;
  if (failureReason && NON_RETRYABLE_REASONS.has(failureReason)) return false;

  const delayMs =
    RETRY_DELAYS_MS[task.retryCount] ??
    RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const retryAfter = new Date(Date.now() + delayMs);

  await prisma.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: taskId },
      data: {
        status: "queued",
        retryCount: { increment: 1 },
        retryAfter,
        lastFailReason: failureReason ?? null,
      },
    });
    // Stamp the most-recent failed log with the reason code.
    const failedLog = await tx.executionLog.findFirst({
      where: { taskId, status: "failed" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (failedLog && failureReason) {
      await tx.executionLog.update({
        where: { id: failedLog.id },
        data: { failureReason },
      });
    }
  });

  const delayMin = Math.round(delayMs / 60_000);
  console.log(
    `[TASK_RETRY_SCHEDULED] taskId="${taskId}" attempt=${task.retryCount + 1}/${task.maxRetries} ` +
      `retryAfter="${retryAfter.toISOString()}" delayMin=${delayMin}`,
  );
  return true;
}
