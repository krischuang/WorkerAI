import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { executeRepair } from "@/lib/self-healing/repair-executor";
import { writeRepairAuditLog } from "@/lib/self-healing/repair-audit";
import { resolveIncident, setIncidentStatus } from "@/lib/self-healing/incident-service";
import { nextAttemptNumber } from "@/lib/self-healing/repair-task-service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const repairTask = await prisma.repairTask.findUnique({
      where: { id },
      include: { incident: true },
    });
    if (!repairTask) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.repairTask.update({ where: { id }, data: { status: "in_progress" } });

    const attemptNum = await nextAttemptNumber(id);
    const attempt = await prisma.repairAttempt.create({
      data: {
        repairTaskId: id,
        attemptNumber: attemptNum,
        executedBy: "system (manual retry)",
        status: "running",
      },
      select: { id: true },
    });

    let result;
    try {
      result = await executeRepair(
        repairTask.incident.source,
        repairTask.incident.affectedAgentId ?? null,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result = {
        success: false,
        logs: `Repair threw: ${errorMessage}`,
        validationOutput: "error",
        validationPassed: false,
        changedFiles: [] as string[],
        errorMessage,
        commitHash: undefined as string | undefined,
      };
    }

    await prisma.repairAttempt.update({
      where: { id: attempt.id },
      data: {
        logs: result.logs.slice(0, 4000),
        validationOutput: result.validationOutput,
        validationPassed: result.validationPassed,
        changedFiles: result.changedFiles,
        commitHash: result.commitHash ?? null,
        status: result.success ? "completed" : "failed",
        completedAt: new Date(),
      },
    });

    const finalStatus = result.validationPassed ? "fixed" : "failed_validation";
    await prisma.repairTask.update({ where: { id }, data: { status: finalStatus } });

    if (result.validationPassed) {
      await resolveIncident(repairTask.incidentId).catch(() => {});
    } else {
      await setIncidentStatus(repairTask.incidentId, "investigating").catch(() => {});
    }

    await writeRepairAuditLog({
      incidentId: repairTask.incidentId,
      repairTaskId: id,
      assignedAgentId: repairTask.assignedAgentId,
      status: finalStatus,
      validationResult: result.validationOutput,
      changedFiles: result.changedFiles,
      commitHash: result.commitHash,
      pushStatus:
        result.changedFiles.length > 0
          ? result.commitHash
            ? "pushed"
            : "not_pushed"
          : "not_applicable",
      errorMessage: result.errorMessage,
    });

    return NextResponse.json({ status: finalStatus, validationPassed: result.validationPassed });
  } catch (err) {
    return serverError("[api/self-healing/repair-tasks/retry]", err);
  }
}
