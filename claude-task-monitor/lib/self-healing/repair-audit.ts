import { prisma } from "@/lib/prisma";

export interface RepairAuditParams {
  incidentId: string;
  repairTaskId: string;
  assignedAgentId?: string | null;
  status: string;
  validationResult?: string;
  changedFiles?: string[];
  commitHash?: string;
  pushStatus?: string;
  errorMessage?: string;
}

export async function writeRepairAuditLog(params: RepairAuditParams): Promise<void> {
  try {
    await prisma.repairAuditLog.create({
      data: {
        incidentId: params.incidentId,
        repairTaskId: params.repairTaskId,
        assignedAgentId: params.assignedAgentId ?? null,
        status: params.status,
        validationResult: params.validationResult ?? null,
        changedFiles: params.changedFiles ?? [],
        commitHash: params.commitHash ?? null,
        pushStatus: params.pushStatus ?? null,
        errorMessage: params.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error("[repair-audit] Failed to write audit log:", err);
  }
}
