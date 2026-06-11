import { prisma } from "./prisma";

const TAG = "[scheduled-resume]";

/** Returns the nearest future reset time from session/week reset fields. */
export function nearestResetsAt(
  sessionResetsAt: Date | null | undefined,
  weekResetsAt: Date | null | undefined,
): Date | null {
  const now = Date.now();
  const candidates = [sessionResetsAt, weekResetsAt].filter(
    (d): d is Date => d instanceof Date && d.getTime() > now,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
}

/**
 * Upsert a ScheduledResume for the given resource.
 * If a pending record already exists, updates its resumeAt and resets triggered=false.
 */
export async function upsertScheduledResume(
  resourceType: "server" | "agent",
  resourceId: string,
  resumeAt: Date,
): Promise<void> {
  try {
    await prisma.scheduledResume.upsert({
      where: { resourceType_resourceId: { resourceType, resourceId } },
      create: { resourceType, resourceId, resumeAt, triggered: false },
      update: { resumeAt, triggered: false },
    });
    console.log(
      `${TAG} Scheduled resume for ${resourceType} ${resourceId} at ${resumeAt.toISOString()}`,
    );
  } catch (err) {
    console.error(`${TAG} Failed to upsert scheduled resume for ${resourceType} ${resourceId}:`, err);
  }
}

export interface TriggeredResume {
  resourceType: "server" | "agent";
  resourceId: string;
}

/**
 * Fire all due scheduled resumes (resumeAt <= now AND triggered=false).
 *
 * Does NOT clear pausedDueToUsage here — the caller (poller) must restart the
 * Claude CLI session and run a fresh /usage check before unpausing, because the
 * Claude CLI process caches usage state and may report stale 100% after the
 * quota actually resets.  pausedDueToUsage is cleared only after the fresh
 * usage check confirms the quota has dropped below the threshold.
 *
 * Returns the list of triggered resources so the caller can schedule restarts.
 */
export async function triggerDueResumes(): Promise<TriggeredResume[]> {
  const now = new Date();
  let due: { id: string; resourceType: string; resourceId: string; resumeAt: Date }[];

  try {
    due = await prisma.scheduledResume.findMany({
      where: { resumeAt: { lte: now }, triggered: false },
      select: { id: true, resourceType: true, resourceId: true, resumeAt: true },
    });
  } catch (err) {
    console.error(`${TAG} Failed to query due resumes:`, err);
    return [];
  }

  if (due.length === 0) return [];

  console.log(`${TAG} ${due.length} due resume(s) — will restart Claude sessions before re-checking usage`);

  const triggered: TriggeredResume[] = [];

  await Promise.allSettled(
    due.map(async (r) => {
      try {
        // Mark triggered first to prevent double-firing on concurrent cycles.
        await prisma.scheduledResume.update({
          where: { id: r.id },
          data: { triggered: true },
        });

        triggered.push({
          resourceType: r.resourceType as "server" | "agent",
          resourceId: r.resourceId,
        });

        console.log(
          `${TAG} Queued session restart for ${r.resourceType} ${r.resourceId} ` +
          `(scheduled for ${r.resumeAt.toISOString()}) — restarting Claude before usage re-check`,
        );
      } catch (err) {
        console.error(
          `${TAG} Failed to trigger resume for ${r.resourceType} ${r.resourceId}:`,
          err,
        );
      }
    }),
  );

  return triggered;
}
