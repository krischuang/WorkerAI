/**
 * Tests for lib/task-dispatch.ts's safety gate: every dispatch must pass the
 * kill switch, the high-risk-autonomous guard, and the policy engine *before*
 * any SSH/tmux action — regardless of which caller (API route, task-service
 * auto-assign, poller) queued the task. This is the defense-in-depth check
 * added so no dispatch path can skip it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: vi.fn(), update: vi.fn() },
    agent: { update: vi.fn() },
    executionLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/dispatch-lock", () => ({
  withServerDispatchLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/audit", () => ({ emitAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/task-secrets", () => ({
  getDecryptedTaskSecrets: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/kill-switch", () => ({
  isSubsystemHalted: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/prompt-firewall", () => ({
  evaluateTaskContent: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock("@/lib/policy-engine", () => ({
  evaluateDispatchPolicy: vi.fn().mockResolvedValue({
    decision: "allow",
    evaluations: [],
    blocked: false,
    requiresApproval: false,
  }),
  getPolicyApproval: vi.fn().mockResolvedValue(null),
  consumePolicyApproval: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ssh-claude-tmux", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ssh-claude-tmux")>("@/lib/ssh-claude-tmux");
  return {
    ...actual,
    sendTaskToTmux: vi.fn().mockResolvedValue({ success: true, outputOffset: 0 }),
  };
});

import { tryDispatchTaskToServer, tryDispatchTaskToAgent } from "../task-dispatch";
import { prisma } from "@/lib/prisma";
import { isSubsystemHalted } from "@/lib/kill-switch";
import { evaluateDispatchPolicy, getPolicyApproval, consumePolicyApproval } from "@/lib/policy-engine";
import { sendTaskToTmux } from "@/lib/ssh-claude-tmux";

const mockTask = vi.mocked(prisma.task);
const mockTransaction = vi.mocked(prisma.$transaction);
const mockIsSubsystemHalted = vi.mocked(isSubsystemHalted);
const mockEvaluateDispatchPolicy = vi.mocked(evaluateDispatchPolicy);
const mockGetPolicyApproval = vi.mocked(getPolicyApproval);
const mockConsumePolicyApproval = vi.mocked(consumePolicyApproval);
const mockSendTaskToTmux = vi.mocked(sendTaskToTmux);

const TASK_ID = "task-1";
const SERVER_ID = "server-1";
const SSH_CONFIG = { host: "h", port: 22, username: "u", sshKeyPath: "/k" };

function lowRiskTask() {
  return { riskLevel: "low", isAutonomous: false, project: { autonomousMode: 0, allowHighRiskAutonomy: false } };
}

function highRiskAutonomousTask(opts?: { autonomousMode?: number; allowHighRiskAutonomy?: boolean }) {
  return {
    riskLevel: "high",
    isAutonomous: true,
    project: {
      autonomousMode: opts?.autonomousMode ?? 0,
      allowHighRiskAutonomy: opts?.allowHighRiskAutonomy ?? false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSubsystemHalted.mockResolvedValue(false);
  mockEvaluateDispatchPolicy.mockResolvedValue({
    decision: "allow",
    evaluations: [],
    blocked: false,
    requiresApproval: false,
  });
  mockSendTaskToTmux.mockResolvedValue({ success: true, outputOffset: 0 } as never);
  mockTransaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
  mockGetPolicyApproval.mockResolvedValue(null);
  mockConsumePolicyApproval.mockResolvedValue(undefined);
});

describe("tryDispatchTaskToServer — safety gate", () => {
  it("blocks dispatch when the taskDispatch subsystem is halted, before any SSH action", async () => {
    mockIsSubsystemHalted.mockResolvedValue(true);

    const result = await tryDispatchTaskToServer({
      taskId: TASK_ID,
      serverId: SERVER_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude",
      permissionMode: "workspace_write",
      task: { title: "Do a thing" },
      logText: "log",
    });

    expect(result).toEqual({ ok: false, reason: "task_not_dispatchable" });
    expect(mockSendTaskToTmux).not.toHaveBeenCalled();
    expect(mockTask.findUnique).not.toHaveBeenCalled();
  });

  it("blocks a high-risk autonomous task when the project has not opted in", async () => {
    mockTask.findUnique.mockResolvedValueOnce(highRiskAutonomousTask() as never);

    const result = await tryDispatchTaskToServer({
      taskId: TASK_ID,
      serverId: SERVER_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude",
      permissionMode: "workspace_write",
      task: { title: "Run a production migration", isAutonomous: true },
      logText: "log",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("task_not_dispatchable");
      expect(result.detail).toBe("high_risk_requires_explicit_opt_in");
    }
    expect(mockSendTaskToTmux).not.toHaveBeenCalled();
  });

  it("allows a high-risk autonomous task through the risk gate once the project opts in", async () => {
    mockTask.findUnique
      .mockResolvedValueOnce(highRiskAutonomousTask({ autonomousMode: 4, allowHighRiskAutonomy: true }) as never)
      .mockResolvedValueOnce({ status: "queued" } as never)
      .mockResolvedValueOnce({ retryCount: 0 } as never);

    const result = await tryDispatchTaskToServer({
      taskId: TASK_ID,
      serverId: SERVER_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude",
      permissionMode: "workspace_write",
      task: { title: "Run a production migration", isAutonomous: true },
      logText: "log",
    });

    expect(result).toEqual({ ok: true });
    expect(mockSendTaskToTmux).toHaveBeenCalledTimes(1);
  });

  it("blocks dispatch when the policy engine returns a deny decision", async () => {
    mockTask.findUnique.mockResolvedValueOnce(lowRiskTask() as never);
    mockEvaluateDispatchPolicy.mockResolvedValue({
      decision: "deny",
      evaluations: [],
      blocked: true,
      requiresApproval: false,
    });

    const result = await tryDispatchTaskToServer({
      taskId: TASK_ID,
      serverId: SERVER_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude",
      permissionMode: "workspace_write",
      task: { title: "Edit .env.production" },
      logText: "log",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toBe("policy_denied");
    expect(mockSendTaskToTmux).not.toHaveBeenCalled();
  });

  it("blocks dispatch when the policy engine requires approval and none has been granted", async () => {
    mockTask.findUnique.mockResolvedValueOnce(lowRiskTask() as never);
    mockEvaluateDispatchPolicy.mockResolvedValue({
      decision: "require_approval",
      evaluations: [],
      blocked: false,
      requiresApproval: true,
    });
    mockGetPolicyApproval.mockResolvedValue(null);

    const result = await tryDispatchTaskToServer({
      taskId: TASK_ID,
      serverId: SERVER_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude",
      permissionMode: "workspace_write",
      task: { title: "Edit middleware.ts" },
      logText: "log",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toBe("policy_requires_approval");
    expect(mockSendTaskToTmux).not.toHaveBeenCalled();
    expect(mockConsumePolicyApproval).not.toHaveBeenCalled();
  });

  it("dispatches once a policy approval has actually been granted, and consumes it so it cannot be reused", async () => {
    mockTask.findUnique
      .mockResolvedValueOnce(lowRiskTask() as never)
      .mockResolvedValueOnce({ status: "queued" } as never)
      .mockResolvedValueOnce({ retryCount: 0 } as never);
    mockEvaluateDispatchPolicy.mockResolvedValue({
      decision: "require_approval",
      evaluations: [],
      blocked: false,
      requiresApproval: true,
    });
    mockGetPolicyApproval.mockResolvedValue({
      approvedBy: "admin",
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      category: "code_execution",
    });

    const result = await tryDispatchTaskToServer({
      taskId: TASK_ID,
      serverId: SERVER_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude",
      permissionMode: "workspace_write",
      task: { title: "Edit middleware.ts" },
      logText: "log",
    });

    expect(result).toEqual({ ok: true });
    expect(mockSendTaskToTmux).toHaveBeenCalledTimes(1);
    expect(mockConsumePolicyApproval).toHaveBeenCalledWith(TASK_ID);
  });

  it("dispatches a normal low-risk task end to end", async () => {
    mockTask.findUnique
      .mockResolvedValueOnce(lowRiskTask() as never)
      .mockResolvedValueOnce({ status: "pending" } as never)
      .mockResolvedValueOnce({ retryCount: 0 } as never);

    const result = await tryDispatchTaskToServer({
      taskId: TASK_ID,
      serverId: SERVER_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude",
      permissionMode: "workspace_write",
      task: { title: "Fix a typo in README" },
      logText: "log",
    });

    expect(result).toEqual({ ok: true });
    expect(mockSendTaskToTmux).toHaveBeenCalledTimes(1);
    expect(mockTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TASK_ID }, data: expect.objectContaining({ status: "running" }) }),
    );
  });
});

describe("tryDispatchTaskToAgent — safety gate", () => {
  const AGENT_ID = "agent-1";

  it("rejects immediately when the agent has no tmuxSession configured", async () => {
    const result = await tryDispatchTaskToAgent({
      taskId: TASK_ID,
      agentId: AGENT_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "",
      task: { title: "Do a thing" },
      logText: "log",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tmux_missing");
    expect(mockIsSubsystemHalted).not.toHaveBeenCalled();
  });

  it("blocks dispatch when the agentExecution subsystem is halted", async () => {
    mockIsSubsystemHalted.mockResolvedValue(true);

    const result = await tryDispatchTaskToAgent({
      taskId: TASK_ID,
      agentId: AGENT_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude-agent-1",
      task: { title: "Do a thing" },
      logText: "log",
    });

    expect(result).toEqual({ ok: false, reason: "task_not_dispatchable" });
    expect(mockSendTaskToTmux).not.toHaveBeenCalled();
  });

  it("blocks a high-risk autonomous task when the project has not opted in", async () => {
    mockTask.findUnique.mockResolvedValueOnce(highRiskAutonomousTask() as never);

    const result = await tryDispatchTaskToAgent({
      taskId: TASK_ID,
      agentId: AGENT_ID,
      sshConfig: SSH_CONFIG,
      tmuxSession: "claude-agent-1",
      task: { title: "Rotate prod secrets", isAutonomous: true },
      logText: "log",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toBe("high_risk_requires_explicit_opt_in");
    expect(mockSendTaskToTmux).not.toHaveBeenCalled();
  });
});
