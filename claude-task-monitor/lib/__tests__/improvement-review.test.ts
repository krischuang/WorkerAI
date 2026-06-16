/**
 * Tests for lib/improvement-review-service.ts:
 *   - signal-gathering query shape (failed/blocked/stale tasks, execution errors, debt items)
 *   - the prompt sent to Claude is English-only and includes the objective + signals
 *   - suggestion-to-task auto-conversion respects autonomousMode and risk gating
 *   - audit events for the review and for skipped high-risk suggestions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn() },
    server: { findUnique: vi.fn() },
    agent: { findUnique: vi.fn() },
    task: { findMany: vi.fn(), count: vi.fn() },
    executionLog: { findMany: vi.fn() },
    debtItem: { findMany: vi.fn() },
    projectScan: { create: vi.fn(), update: vi.fn() },
    taskSuggestion: { count: vi.fn(), findMany: vi.fn() },
    improvementCycle: { create: vi.fn() },
  },
}));

vi.mock("@/lib/ssh-claude-tmux", () => ({
  sendRawPromptToTmux: vi.fn(),
}));

vi.mock("@/lib/dispatch-lock", () => ({
  withServerDispatchLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/audit", () => ({
  emitAudit: vi.fn(),
}));

vi.mock("@/lib/improvement-cycle-service", () => ({
  resolveSessionForProject: vi.fn(),
}));

vi.mock("@/lib/project-scan-service", () => ({
  waitForClaudeIdle: vi.fn(),
}));

vi.mock("@/lib/suggestion-service", () => ({
  approveSuggestion: vi.fn(),
}));

import { runImprovementReview } from "../improvement-review-service";
import { prisma } from "@/lib/prisma";
import { sendRawPromptToTmux } from "@/lib/ssh-claude-tmux";
import { resolveSessionForProject } from "@/lib/improvement-cycle-service";
import { waitForClaudeIdle } from "@/lib/project-scan-service";
import { approveSuggestion } from "@/lib/suggestion-service";

const mockProjectFindUnique = vi.mocked(prisma.project.findUnique);
const mockServerFindUnique = vi.mocked(prisma.server.findUnique);
const mockTaskFindMany = vi.mocked(prisma.task.findMany);
const mockTaskCount = vi.mocked(prisma.task.count);
const mockExecutionLogFindMany = vi.mocked(prisma.executionLog.findMany);
const mockDebtFindMany = vi.mocked(prisma.debtItem.findMany);
const mockScanCreate = vi.mocked(prisma.projectScan.create);
const mockScanUpdate = vi.mocked(prisma.projectScan.update);
const mockSuggestionCount = vi.mocked(prisma.taskSuggestion.count);
const mockSuggestionFindMany = vi.mocked(prisma.taskSuggestion.findMany);
const mockCycleCreate = vi.mocked(prisma.improvementCycle.create);
const mockSendPrompt = vi.mocked(sendRawPromptToTmux);
const mockResolveSession = vi.mocked(resolveSessionForProject);
const mockWaitIdle = vi.mocked(waitForClaudeIdle);
const mockApproveSuggestion = vi.mocked(approveSuggestion);

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Proj",
    autonomousMode: 1,
    allowHighRiskAutonomy: false,
    objective: "Ship a reliable dispatcher.",
    successCriteria: "Zero manual interventions per week.",
    constraints: null,
    nonGoals: null,
    improvementFocus: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskFindMany.mockResolvedValue([]);
  mockExecutionLogFindMany.mockResolvedValue([]);
  mockDebtFindMany.mockResolvedValue([]);
  mockTaskCount.mockResolvedValue(0);
  mockScanCreate.mockResolvedValue({ id: "scan-1" } as never);
  mockScanUpdate.mockResolvedValue({} as never);
  mockSendPrompt.mockResolvedValue({ success: true });
  mockWaitIdle.mockResolvedValue("idle");
  mockSuggestionCount.mockResolvedValue(0);
  mockSuggestionFindMany.mockResolvedValue([]);
  mockCycleCreate.mockResolvedValue({ id: "cycle-1" } as never);
  mockResolveSession.mockResolvedValue({ serverId: "srv1" });
  mockServerFindUnique.mockResolvedValue({ host: "h", port: 22, username: "u", sshKeyPath: "/k", tmuxSession: "claude" } as never);
});

describe("runImprovementReview — signal gathering", () => {
  it("queries failed, blocked, and stale tasks, recent execution errors, and open debt items", async () => {
    mockProjectFindUnique.mockResolvedValue(project() as never);

    await runImprovementReview("p1");

    expect(mockTaskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: "p1", status: "failed" }),
    }));
    expect(mockTaskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: "p1", blockedByCount: { gt: 0 } }),
    }));
    expect(mockTaskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: "p1", status: { in: ["pending", "queued"] } }),
    }));
    expect(mockExecutionLogFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "failed" }),
    }));
    expect(mockDebtFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: "p1", status: "open" }),
    }));
  });

  it("returns not_found for a missing project", async () => {
    mockProjectFindUnique.mockResolvedValue(null);
    const result = await runImprovementReview("missing");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("runImprovementReview — prompt content", () => {
  it("includes the objective and is English-only, with explicit English instruction", async () => {
    mockProjectFindUnique.mockResolvedValue(project() as never);
    mockTaskFindMany.mockResolvedValueOnce([{ title: "Fix login bug", lastFailReason: "Timeout" }] as never); // failedTasks

    await runImprovementReview("p1");

    const promptText = mockSendPrompt.mock.calls[0][1] as string;
    expect(promptText).toMatch(/Ship a reliable dispatcher\./);
    expect(promptText).toMatch(/Fix login bug/);
    expect(promptText).toMatch(/Write every title, description, and rationale in English/);
    expect(promptText).toMatch(/Prioritize, in this order: failed tasks/);
  });
});

describe("runImprovementReview — autonomous conversion gating", () => {
  it("at autonomousMode 1, leaves suggestions pending_review (no auto-conversion)", async () => {
    mockProjectFindUnique.mockResolvedValue(project({ autonomousMode: 1 }) as never);
    mockSuggestionCount.mockResolvedValue(2);

    const result = await runImprovementReview("p1");

    expect(mockApproveSuggestion).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, suggestionsGenerated: 2, tasksAutoCreated: 0 });
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "awaiting_approval" }),
    }));
  });

  it("at autonomousMode 2, auto-converts low/medium-risk suggestions", async () => {
    mockProjectFindUnique.mockResolvedValue(project({ autonomousMode: 2 }) as never);
    mockSuggestionCount.mockResolvedValue(1);
    mockSuggestionFindMany.mockResolvedValue([
      { id: "sugg-1", title: "Improve test coverage", description: "Add unit tests", taskType: "coding" },
    ] as never);
    mockApproveSuggestion.mockResolvedValue({ ok: true, taskId: "task-1" });

    const result = await runImprovementReview("p1");

    expect(mockApproveSuggestion).toHaveBeenCalledWith("sugg-1", { isAutonomous: true });
    expect(result).toMatchObject({ ok: true, tasksAutoCreated: 1 });
  });

  it("skips a high-risk suggestion at autonomousMode 2 (below the high-risk floor of 4)", async () => {
    mockProjectFindUnique.mockResolvedValue(project({ autonomousMode: 2 }) as never);
    mockSuggestionCount.mockResolvedValue(1);
    mockSuggestionFindMany.mockResolvedValue([
      { id: "sugg-1", title: "Run database migration", description: "Add new column", taskType: "coding" },
    ] as never);

    const result = await runImprovementReview("p1");

    expect(mockApproveSuggestion).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, tasksAutoCreated: 0 });
  });

  it("auto-converts a high-risk suggestion only at autonomousMode 4 with allowHighRiskAutonomy", async () => {
    mockProjectFindUnique.mockResolvedValue(project({ autonomousMode: 4, allowHighRiskAutonomy: true }) as never);
    mockSuggestionCount.mockResolvedValue(1);
    mockSuggestionFindMany.mockResolvedValue([
      { id: "sugg-1", title: "Run database migration", description: "Add new column", taskType: "coding" },
    ] as never);
    mockApproveSuggestion.mockResolvedValue({ ok: true, taskId: "task-1" });

    const result = await runImprovementReview("p1");

    expect(mockApproveSuggestion).toHaveBeenCalledWith("sugg-1", { isAutonomous: true });
    expect(result).toMatchObject({ ok: true, tasksAutoCreated: 1 });
  });
});
