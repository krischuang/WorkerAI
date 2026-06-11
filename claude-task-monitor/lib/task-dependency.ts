import { prisma } from "@/lib/prisma";

/**
 * DFS from `startId` following dependency edges upward (dependsOn chain).
 * Returns true if `targetId` is reachable — i.e. adding (taskId → dependsOnId)
 * where dependsOnId=startId would create a cycle.
 */
async function wouldCreateCycle(taskId: string, dependsOnId: string): Promise<boolean> {
  // We want to detect: can we reach `taskId` starting from `dependsOnId`
  // by following existing dependsOn edges? If yes, the new edge creates a cycle.
  const visited = new Set<string>();
  const queue = [dependsOnId];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const edges = await prisma.taskDependency.findMany({
      where: { taskId: current },
      select: { dependsOnId: true },
    });
    for (const e of edges) queue.push(e.dependsOnId);
  }
  return false;
}

export async function addDependency(
  taskId: string,
  dependsOnId: string
): Promise<{ ok: true } | { ok: false; reason: "cycle" | "self" | "not_found" | "already_exists" }> {
  if (taskId === dependsOnId) return { ok: false, reason: "self" };

  const [task, dep] = await Promise.all([
    prisma.task.findUnique({ where: { id: taskId }, select: { id: true } }),
    prisma.task.findUnique({ where: { id: dependsOnId }, select: { id: true, status: true } }),
  ]);
  if (!task || !dep) return { ok: false, reason: "not_found" };

  if (await wouldCreateCycle(taskId, dependsOnId)) return { ok: false, reason: "cycle" };

  // Only count as blocking if prerequisite is not yet completed/archived
  const depTask = dep as { id: string; status: string };
  const isBlocking = depTask.status !== "completed" && depTask.status !== "archived";

  try {
    await prisma.$transaction(async (tx) => {
      await tx.taskDependency.create({ data: { taskId, dependsOnId } });
      if (isBlocking) {
        await tx.task.update({
          where: { id: taskId },
          data: { blockedByCount: { increment: 1 } },
        });
      }
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      return { ok: false, reason: "already_exists" };
    }
    throw err;
  }

  return { ok: true };
}

export async function removeDependency(
  taskId: string,
  dependsOnId: string
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  const existing = await prisma.taskDependency.findUnique({
    where: { taskId_dependsOnId: { taskId, dependsOnId } },
    include: { dependsOn: { select: { status: true } } },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  const wasBlocking =
    existing.dependsOn.status !== "completed" && existing.dependsOn.status !== "archived";

  await prisma.$transaction(async (tx) => {
    await tx.taskDependency.delete({
      where: { taskId_dependsOnId: { taskId, dependsOnId } },
    });
    if (wasBlocking) {
      await tx.task.update({
        where: { id: taskId },
        data: { blockedByCount: { decrement: 1 } },
      });
    }
  });

  return { ok: true };
}

/**
 * Called after a task reaches completed or archived status.
 * Decrements blockedByCount on all direct dependents; auto-advances those
 * that reach 0 back to queued if they are currently pending.
 */
export async function unblockDependents(completedTaskId: string): Promise<void> {
  const dependents = await prisma.taskDependency.findMany({
    where: { dependsOnId: completedTaskId },
    select: { taskId: true },
  });

  if (dependents.length === 0) return;

  for (const { taskId } of dependents) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: taskId },
        data: { blockedByCount: { decrement: 1 } },
        select: { blockedByCount: true, status: true, serverId: true, agentId: true },
      });
      // If now unblocked and still pending with an assigned resource, advance to queued
      if (
        updated.blockedByCount <= 0 &&
        updated.status === "pending" &&
        (updated.serverId || updated.agentId)
      ) {
        await tx.task.update({
          where: { id: taskId },
          data: { blockedByCount: 0, status: "queued" },
        });
      } else if (updated.blockedByCount < 0) {
        // Clamp to 0 to prevent drift
        await tx.task.update({ where: { id: taskId }, data: { blockedByCount: 0 } });
      }
    });
  }
}
