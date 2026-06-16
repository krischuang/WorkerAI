/**
 * Completion validation gate for Task.isAutonomous tasks.
 *
 * Tasks created/dispatched by the autonomous improvement pipeline (Project.autonomousMode >= 2)
 * must prove their work with evidence — a [WORKERAI_VALIDATION] block (see
 * lib/prompt-sanitiser.ts) reporting a test/build/lint result or an explicit verification note —
 * before they can be marked "completed". This module is the single place that decides whether
 * a completion marker is allowed to actually complete the task, called from every completion
 * site in instrumentation.node.ts.
 */

import { prisma } from "@/lib/prisma";
import { detectValidationBlock } from "@/lib/usage-parser";
import { emitAudit } from "@/lib/audit";

export interface ValidationGateResult {
  /** true = the caller may proceed to mark the task completed. */
  allowed: boolean;
  /** null when the task isn't isAutonomous (gate not applicable, always allowed). */
  validationStatus: "passed" | "failed" | "missing" | null;
  evidence: string | null;
}

/**
 * Evaluate (and, when blocking, immediately apply) the validation gate for a task whose
 * completion marker was just detected.
 *
 * - validation passed → Task.validationStatus is recorded, caller proceeds to "completed".
 * - validation explicitly failed (block present, result: failed) → this function marks the
 *   task "failed" itself and creates an English-language follow-up task carrying the evidence,
 *   so a human or another autonomous cycle has something concrete to act on.
 * - validation block missing entirely → treated as a protocol violation: marked "failed" with
 *   a clear reason, no follow-up task (there is no evidence to build one from).
 *
 * Non-autonomous tasks always return { allowed: true, validationStatus: null }.
 */
export async function applyValidationGate(opts: {
  taskId: string;
  projectId: string;
  title: string;
  isAutonomous: boolean;
  paneText: string;
  expectedNonce: string | null | undefined;
}): Promise<ValidationGateResult> {
  if (!opts.isAutonomous) {
    return { allowed: true, validationStatus: null, evidence: null };
  }

  const block = opts.expectedNonce
    ? detectValidationBlock(opts.paneText, opts.taskId, opts.expectedNonce)
    : { found: false, status: null as "passed" | "failed" | null, evidence: null };

  if (block.found && block.status === "passed") {
    await prisma.task.update({
      where: { id: opts.taskId },
      data: { validationStatus: "passed", validationEvidence: block.evidence },
    }).catch(() => {});
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.validation_passed",
      actorType: "poller",
      payload: { evidence: block.evidence },
    });
    return { allowed: true, validationStatus: "passed", evidence: block.evidence };
  }

  if (block.found && block.status === "failed") {
    await prisma.task.update({
      where: { id: opts.taskId },
      data: {
        status: "failed",
        validationStatus: "failed",
        validationEvidence: block.evidence,
        lastFailReason: `Autonomous validation failed: ${block.evidence ?? "no evidence provided"}`,
      },
    }).catch(() => {});
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.validation_failed",
      actorType: "poller",
      payload: { evidence: block.evidence, reason: "validation_block_reported_failed" },
    });

    const followUp = await prisma.task.create({
      data: {
        projectId: opts.projectId,
        title: `Fix validation failure from autonomous task: ${opts.title}`.slice(0, 200),
        description:
          `The autonomous task "${opts.title}" (id: ${opts.taskId}) reported completion but failed ` +
          `its validation check.\n\nValidation evidence reported by the agent:\n` +
          `${block.evidence ?? "No evidence was provided."}\n\n` +
          `Please investigate and fix the underlying issue.`,
        taskType: "maintenance",
        priority: "P2",
        riskLevel: "medium",
        isAutonomous: false,
      },
    });
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.auto_followup_created",
      actorType: "poller",
      payload: { followUpTaskId: followUp.id },
    });

    return { allowed: false, validationStatus: "failed", evidence: block.evidence };
  }

  // Missing entirely — a protocol violation with no actionable evidence to build a follow-up
  // from, so we fail clearly rather than guessing at what went wrong.
  await prisma.task.update({
    where: { id: opts.taskId },
    data: {
      status: "failed",
      validationStatus: "missing",
      lastFailReason: "Autonomous task reported completion without the required validation evidence block.",
    },
  }).catch(() => {});
  await emitAudit({
    entityType: "task",
    entityId: opts.taskId,
    eventType: "task.validation_failed",
    actorType: "poller",
    payload: { reason: "missing_validation_block" },
  });

  return { allowed: false, validationStatus: "missing", evidence: null };
}
