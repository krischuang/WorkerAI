/**
 * Tests for lib/validation-gate.ts — the completion gate that requires Task.isAutonomous tasks
 * to prove their work with a [WORKERAI_VALIDATION] block before being marked "completed".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { update: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/audit", () => ({
  emitAudit: vi.fn(),
}));

import { applyValidationGate } from "../validation-gate";
import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";

const mockTaskUpdate = vi.mocked(prisma.task.update);
const mockTaskCreate = vi.mocked(prisma.task.create);
const mockEmitAudit = vi.mocked(emitAudit);

const TASK_ID = "task-1";
const PROJECT_ID = "proj-1";
const NONCE = "nonce-xyz";

function passedBlock(evidence = "npm test: 10 passed.") {
  return [
    "[WORKERAI_VALIDATION]",
    `taskId: ${TASK_ID}`,
    `nonce: ${NONCE}`,
    "result: passed",
    `evidence: ${evidence}`,
    "[/WORKERAI_VALIDATION]",
  ].join("\n");
}

function failedBlock(evidence = "npm test: 2 failed.") {
  return [
    "[WORKERAI_VALIDATION]",
    `taskId: ${TASK_ID}`,
    `nonce: ${NONCE}`,
    "result: failed",
    `evidence: ${evidence}`,
    "[/WORKERAI_VALIDATION]",
  ].join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskUpdate.mockResolvedValue({} as never);
  mockTaskCreate.mockResolvedValue({ id: "followup-1" } as never);
});

describe("applyValidationGate — non-autonomous tasks", () => {
  it("is always allowed and makes no DB writes or audit events", async () => {
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Some task",
      isAutonomous: false,
      paneText: "anything, doesn't matter",
      expectedNonce: NONCE,
    });
    expect(result).toEqual({ allowed: true, validationStatus: null, evidence: null });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(mockEmitAudit).not.toHaveBeenCalled();
  });
});

describe("applyValidationGate — autonomous tasks, validation passed", () => {
  it("allows completion and records validationStatus=passed", async () => {
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Add a button",
      isAutonomous: true,
      paneText: passedBlock("npm test: 42 passed, 0 failed."),
      expectedNonce: NONCE,
    });

    expect(result.allowed).toBe(true);
    expect(result.validationStatus).toBe("passed");
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: { validationStatus: "passed", validationEvidence: "npm test: 42 passed, 0 failed." },
    });
    expect(mockEmitAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "task.validation_passed" }));
    expect(mockTaskCreate).not.toHaveBeenCalled();
  });
});

describe("applyValidationGate — autonomous tasks, validation explicitly failed", () => {
  it("blocks completion, marks the task failed, and creates an English follow-up task", async () => {
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Refactor auth module",
      isAutonomous: true,
      paneText: failedBlock("npm test: 2 failed - login.spec.ts"),
      expectedNonce: NONCE,
    });

    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("failed");

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: expect.objectContaining({
        status: "failed",
        validationStatus: "failed",
        validationEvidence: "npm test: 2 failed - login.spec.ts",
      }),
    });

    expect(mockTaskCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockTaskCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.projectId).toBe(PROJECT_ID);
    expect(createArgs.data.isAutonomous).toBe(false);
    expect(String(createArgs.data.title)).toMatch(/Refactor auth module/);
    expect(String(createArgs.data.description)).toMatch(/npm test: 2 failed - login\.spec\.ts/);
    // English-only requirement: no non-ASCII letters in generated text.
    expect(String(createArgs.data.title)).toMatch(/^[\x00-\x7F]*$/);
    expect(String(createArgs.data.description)).toMatch(/^[\x00-\x7F]*$/);

    expect(mockEmitAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "task.validation_failed" }));
    expect(mockEmitAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "task.auto_followup_created" }));
  });
});

describe("applyValidationGate — validation block missing entirely", () => {
  it("blocks completion with validationStatus=missing and creates NO follow-up task", async () => {
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Some task",
      isAutonomous: true,
      paneText: "[WORKERAI_RESULT]\ntaskId: task-1\nstatus: completed\nnonce: nonce-xyz\n[/WORKERAI_RESULT]",
      expectedNonce: NONCE,
    });

    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("missing");
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: expect.objectContaining({ status: "failed", validationStatus: "missing" }),
    });
    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(mockEmitAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "task.validation_failed" }));
  });

  it("treats a missing nonce the same as a missing block", async () => {
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Some task",
      isAutonomous: true,
      paneText: passedBlock(),
      expectedNonce: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("missing");
  });
});
