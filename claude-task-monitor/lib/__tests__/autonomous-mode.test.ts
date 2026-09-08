/**
 * Tests for lib/task-service.ts's autoAssignQueuedTasks — the autonomous mode admission rules:
 *   - high-risk tasks are never auto-dispatched unless autonomousMode >= 4 AND
 *     Project.allowHighRiskAutonomy is explicitly true
 *   - every decision (assigned or rejected) emits an AuditEvent
 *   - the best eligible agent (per lib/agent-selector.ts) is the one chosen
 *
 * Project.autonomousMode >= 3 gating itself is enforced by the Prisma `where` clause
 * (project: { autonomousMode: { gte: 3 } }) — covered here by asserting the query shape and by
 * the fact that the mocked findMany simply returns what we tell it to (i.e. tasks belonging to
 * lower-mode projects never reach the candidate list in the first place).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    agent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/audit", () => ({
  emitAudit: vi.fn(),
}));

import { autoAssignQueuedTasks } from "../task-service";
import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";

const mockTaskFindMany = vi.mocked(prisma.task.findMany);
const mockTaskUpdate = vi.mocked(prisma.task.update);
const mockTaskFindUnique = vi.mocked(prisma.task.findUnique);
const mockTaskGroupBy = vi.mocked(prisma.task.groupBy);
const mockAgentFindMany = vi.mocked(prisma.agent.findMany);
const mockEmitAudit = vi.mocked(emitAudit);

function project(overrides: Partial<{ autonomousMode: number; allowHighRiskAutonomy: boolean }> = {}) {
  return { id: "proj-1", name: "Project One", autonomousMode: 3, allowHighRiskAutonomy: false, ...overrides };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    requiredTags: [],
    riskLevel: "medium",
    project: project(),
    ...overrides,
  };
}

function idleAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    name: "Agent One",
    tags: [],
    status: "idle",
    healthScore: 100,
    activeTaskCount: 0,
    maxConcurrentTasks: 3,
    claudeSessionPct: 5,
    claudeWeekPct: 5,
    pausedDueToUsage: false,
    cooldownUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskUpdate.mockResolvedValue({} as never);
  // dispatchTask (called internally after assignment) looks the task up again; returning
  // null makes it short-circuit to { ok: false, reason: "not_found" } without side effects —
  // we only care about the assignment/audit behavior in these tests, not dispatch mechanics.
  mockTaskFindUnique.mockResolvedValue(null as never);
  // Real-time workload query (added alongside the groupBy-based queue-depth
  // calculation in task-service.ts). Empty by default: none of these tests
  // exercise workload-based agent selection, so no agent has a running/queued
  // backlog unless a test explicitly overrides this.
  mockTaskGroupBy.mockResolvedValue([] as never);
});

describe("autoAssignQueuedTasks — high-risk gating", () => {
  it("skips a high-risk task when autonomousMode is 3 (below the high-risk floor of 4)", async () => {
    mockTaskFindMany.mockResolvedValue([task({ riskLevel: "high", project: project({ autonomousMode: 3 }) })] as never);
    mockAgentFindMany.mockResolvedValue([idleAgent()] as never);

    const result = await autoAssignQueuedTasks();

    expect(result.assigned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "agent.rejected", payload: expect.objectContaining({ reason: "high_risk_requires_explicit_opt_in" }) }),
    );
  });

  it("skips a high-risk task at autonomousMode 4 when allowHighRiskAutonomy is false", async () => {
    mockTaskFindMany.mockResolvedValue([
      task({ riskLevel: "high", project: project({ autonomousMode: 4, allowHighRiskAutonomy: false }) }),
    ] as never);
    mockAgentFindMany.mockResolvedValue([idleAgent()] as never);

    const result = await autoAssignQueuedTasks();
    expect(result.assigned).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("allows a high-risk task only when autonomousMode is 4 AND allowHighRiskAutonomy is true", async () => {
    mockTaskFindMany.mockResolvedValue([
      task({ riskLevel: "high", project: project({ autonomousMode: 4, allowHighRiskAutonomy: true }) }),
    ] as never);
    mockAgentFindMany.mockResolvedValue([idleAgent()] as never);

    const result = await autoAssignQueuedTasks();
    expect(result.assigned).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockTaskUpdate).toHaveBeenCalledWith({ where: { id: "task-1" }, data: { agentId: "agent-1", status: "queued" } });
  });

  it("low and medium risk tasks are never blocked by the high-risk gate", async () => {
    mockTaskFindMany.mockResolvedValue([
      task({ id: "low-task", riskLevel: "low" }),
    ] as never);
    mockAgentFindMany.mockResolvedValue([idleAgent()] as never);

    const result = await autoAssignQueuedTasks();
    expect(result.assigned).toBe(1);
  });
});

describe("autoAssignQueuedTasks — agent selection + audit trail", () => {
  it("assigns the best-scoring eligible agent and emits agent.selected", async () => {
    mockTaskFindMany.mockResolvedValue([task()] as never);
    mockAgentFindMany.mockResolvedValue([
      idleAgent({ id: "busy", activeTaskCount: 2, claudeSessionPct: 50 }),
      idleAgent({ id: "best", activeTaskCount: 0, claudeSessionPct: 1 }),
    ] as never);

    const result = await autoAssignQueuedTasks();

    expect(result.assigned).toBe(1);
    expect(mockTaskUpdate).toHaveBeenCalledWith({ where: { id: "task-1" }, data: { agentId: "best", status: "queued" } });
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "agent.selected", payload: expect.objectContaining({ agentId: "best" }) }),
    );
  });

  it("emits agent.rejected with reasons when no agent is eligible", async () => {
    mockTaskFindMany.mockResolvedValue([task()] as never);
    mockAgentFindMany.mockResolvedValue([idleAgent({ status: "offline" })] as never);

    const result = await autoAssignQueuedTasks();

    expect(result.assigned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "agent.rejected", payload: expect.objectContaining({ reason: "no_eligible_agent" }) }),
    );
  });

  it("respects required tags when selecting an agent", async () => {
    mockTaskFindMany.mockResolvedValue([task({ requiredTags: ["gpu"] })] as never);
    mockAgentFindMany.mockResolvedValue([
      idleAgent({ id: "no-gpu", tags: [] }),
      idleAgent({ id: "has-gpu", tags: ["gpu"] }),
    ] as never);

    const result = await autoAssignQueuedTasks();
    expect(result.assigned).toBe(1);
    expect(mockTaskUpdate).toHaveBeenCalledWith({ where: { id: "task-1" }, data: { agentId: "has-gpu", status: "queued" } });
  });

  it("returns immediately with no agent query when there are no candidate tasks", async () => {
    mockTaskFindMany.mockResolvedValue([] as never);
    const result = await autoAssignQueuedTasks();
    expect(result).toEqual({ assigned: 0, skipped: 0 });
    expect(mockAgentFindMany).not.toHaveBeenCalled();
  });

  it("only queries tasks belonging to projects with autonomousMode >= 3", async () => {
    mockTaskFindMany.mockResolvedValue([] as never);
    await autoAssignQueuedTasks();
    expect(mockTaskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "pending",
          agentId: null,
          serverId: null,
          project: expect.objectContaining({ autonomousMode: { gte: 3 } }),
        }),
      }),
    );
  });
});
