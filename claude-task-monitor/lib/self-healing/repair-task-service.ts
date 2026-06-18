import { prisma } from "@/lib/prisma";
import type { RiskLevel, RepairTaskStatus } from "@/app/generated/prisma/client";

export interface RepairTaskInput {
  title: string;
  description: string;
  suggestedSteps: string[];
  riskLevel: RiskLevel;
}

/** Create a repair task for an incident if no active one exists. */
export async function createRepairTaskIfNew(
  incidentId: string,
  input: RepairTaskInput,
): Promise<{ taskId: string; isNew: boolean }> {
  const existing = await prisma.repairTask.findFirst({
    where: {
      incidentId,
      status: { notIn: ["fixed", "failed"] },
    },
    select: { id: true },
  });

  if (existing) return { taskId: existing.id, isNew: false };

  const task = await prisma.repairTask.create({
    data: {
      incidentId,
      title: input.title,
      description: input.description,
      suggestedSteps: input.suggestedSteps,
      riskLevel: input.riskLevel,
      status: "pending",
    },
    select: { id: true },
  });

  return { taskId: task.id, isNew: true };
}

/** Fetch all repair tasks that are ready to be executed. */
export async function getPendingRepairTasks() {
  return prisma.repairTask.findMany({
    where: { status: "pending" },
    include: {
      incident: true,
      repairAttempts: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function updateRepairTaskStatus(
  taskId: string,
  status: RepairTaskStatus,
  assignedAgentId?: string | null,
): Promise<void> {
  await prisma.repairTask.update({
    where: { id: taskId },
    data: {
      status,
      ...(assignedAgentId !== undefined ? { assignedAgentId } : {}),
    },
  });
}

export async function nextAttemptNumber(repairTaskId: string): Promise<number> {
  const count = await prisma.repairAttempt.count({ where: { repairTaskId } });
  return count + 1;
}
