import { prisma } from "./prisma";
import { nextCronDate } from "./cron-schedule";
import { emitAudit } from "./audit";
import { recalculateProjectProgress } from "./project-progress";

/**
 * Called every poller cycle. Finds enabled ScheduledTasks whose nextRunAt has
 * passed, creates a new pending Task for each, then advances nextRunAt.
 */
export async function runDueScheduledTasks(): Promise<void> {
  const now = new Date();
  const due = await prisma.scheduledTask.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
  });

  for (const st of due) {
    // Spawn a new pending task
    const task = await prisma.task.create({
      data: {
        projectId: st.projectId,
        title: st.title,
        description: st.description,
        priority: st.priority,
        status: "pending",
        taskType: st.taskType,
        estimatedCostLevel: st.estimatedCostLevel,
        ...(st.timeoutMinutes != null && { timeoutMinutes: st.timeoutMinutes }),
        maxRetries: st.maxRetries,
        scheduledTaskId: st.id,
      },
    });

    emitAudit({
      entityType: "task",
      entityId: task.id,
      eventType: "task.created",
      actorType: "system",
      payload: { source: "scheduled_task", scheduledTaskId: st.id },
    }).catch(() => {});

    recalculateProjectProgress(st.projectId).catch(() => {});

    // Compute next run time
    let nextRunAt: Date | null = null;
    try {
      nextRunAt = nextCronDate(st.cronSchedule, now);
    } catch {
      // If expression is somehow invalid, disable the schedule to stop infinite retries
      await prisma.scheduledTask.update({
        where: { id: st.id },
        data: { enabled: false, lastRunAt: now, nextRunAt: null },
      });
      console.error(`[scheduled-tasks] Disabled schedule ${st.id} — invalid cron: ${st.cronSchedule}`);
      continue;
    }

    await prisma.scheduledTask.update({
      where: { id: st.id },
      data: { lastRunAt: now, nextRunAt },
    });

    console.log(
      `[scheduled-tasks] Spawned task ${task.id} from schedule ${st.id} ("${st.title}"); next run: ${nextRunAt.toISOString()}`
    );
  }
}

/**
 * Computes and persists nextRunAt for a newly created or updated ScheduledTask.
 */
export async function refreshNextRunAt(scheduledTaskId: string): Promise<void> {
  const st = await prisma.scheduledTask.findUnique({ where: { id: scheduledTaskId } });
  if (!st) return;
  try {
    const nextRunAt = nextCronDate(st.cronSchedule);
    await prisma.scheduledTask.update({ where: { id: scheduledTaskId }, data: { nextRunAt } });
  } catch {
    // Invalid expression — leave nextRunAt null
  }
}
