/**
 * Tests for lib/project-objective-service.ts:
 *   1. validateObjectiveUpdate — pure validation rules for manual edits
 *   2. generateProjectObjective — "Generate Objective with Claude" end-to-end flow (mocked SSH)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn() },
    server: { findUnique: vi.fn() },
    agent: { findUnique: vi.fn() },
    task: { findMany: vi.fn(), count: vi.fn() },
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

import { generateProjectObjective, validateObjectiveUpdate } from "../project-objective-service";
import { prisma } from "@/lib/prisma";
import { sendRawPromptToTmux } from "@/lib/ssh-claude-tmux";
import { resolveSessionForProject } from "@/lib/improvement-cycle-service";
import { waitForClaudeIdle } from "@/lib/project-scan-service";

const mockProjectFindUnique = vi.mocked(prisma.project.findUnique);
const mockServerFindUnique = vi.mocked(prisma.server.findUnique);
const mockAgentFindUnique = vi.mocked(prisma.agent.findUnique);
const mockTaskFindMany = vi.mocked(prisma.task.findMany);
const mockTaskCount = vi.mocked(prisma.task.count);
const mockSendPrompt = vi.mocked(sendRawPromptToTmux);
const mockResolveSession = vi.mocked(resolveSessionForProject);
const mockWaitIdle = vi.mocked(waitForClaudeIdle);

describe("validateObjectiveUpdate", () => {
  it("accepts a fully valid input", () => {
    expect(validateObjectiveUpdate({ objective: "Ship the thing", autonomousMode: 2 })).toBeNull();
  });

  it("rejects an objective field longer than 2000 characters", () => {
    const err = validateObjectiveUpdate({ objective: "x".repeat(2001) });
    expect(err).toMatch(/objective/);
  });

  it("rejects autonomousMode out of the 0-4 range", () => {
    expect(validateObjectiveUpdate({ autonomousMode: 5 })).toMatch(/autonomousMode/);
    expect(validateObjectiveUpdate({ autonomousMode: -1 })).toMatch(/autonomousMode/);
  });

  it("rejects a non-integer autonomousMode", () => {
    expect(validateObjectiveUpdate({ autonomousMode: 2.5 })).toMatch(/autonomousMode/);
  });

  it("allows autonomousMode to be omitted", () => {
    expect(validateObjectiveUpdate({ objective: "fine" })).toBeNull();
  });
});

describe("generateProjectObjective", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskFindMany.mockResolvedValue([]);
    mockTaskCount.mockResolvedValue(0);
    mockWaitIdle.mockResolvedValue("idle");
    mockSendPrompt.mockResolvedValue({ success: true });
  });

  it("returns not_found when the project does not exist", async () => {
    mockProjectFindUnique.mockResolvedValue(null);
    const result = await generateProjectObjective("missing-project");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns no_session when no server or agent is available", async () => {
    mockProjectFindUnique.mockResolvedValue({ id: "p1", name: "Proj", description: null } as never);
    mockResolveSession.mockResolvedValue(null);
    const result = await generateProjectObjective("p1");
    expect(result).toEqual({ ok: false, reason: "no_session" });
  });

  it("drafts the objective via SSH and reports the updated fields", async () => {
    mockProjectFindUnique
      .mockResolvedValueOnce({ id: "p1", name: "Proj", description: "A test project" } as never)
      // second call re-reads the row after Claude's UPDATE
      .mockResolvedValueOnce({
        objective: "Ship reliable autonomous dispatch.",
        successCriteria: "All tasks auto-assigned correctly.",
        constraints: "Single-user app.",
        nonGoals: "Multi-tenant support.",
        improvementFocus: "Test coverage.",
      } as never);
    mockResolveSession.mockResolvedValue({ serverId: "srv1" });
    mockServerFindUnique
      .mockResolvedValueOnce({ host: "h", port: 22, username: "u", sshKeyPath: "/k" } as never)
      .mockResolvedValueOnce({ tmuxSession: "claude" } as never);

    const result = await generateProjectObjective("p1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.objective).toMatch(/reliable autonomous dispatch/);
    }
    expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    const promptText = mockSendPrompt.mock.calls[0][1] as string;
    expect(promptText).toMatch(/UPDATE[\s\S]*"Project"/);
    expect(promptText).toMatch(/Write all five fields in English/);
  });

  it("returns server_busy without sending a prompt when the resource has running tasks", async () => {
    mockProjectFindUnique.mockResolvedValue({ id: "p1", name: "Proj", description: null } as never);
    mockResolveSession.mockResolvedValue({ serverId: "srv1" });
    mockServerFindUnique
      .mockResolvedValueOnce({ host: "h", port: 22, username: "u", sshKeyPath: "/k" } as never)
      .mockResolvedValueOnce({ tmuxSession: "claude" } as never);
    mockTaskCount.mockResolvedValue(1);

    const result = await generateProjectObjective("p1");
    expect(result).toEqual({ ok: false, reason: "server_busy" });
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  it("routes through the agent's tmux session when the resolved session has an agentId", async () => {
    mockProjectFindUnique
      .mockResolvedValueOnce({ id: "p1", name: "Proj", description: null } as never) // initial lookup
      .mockResolvedValueOnce({} as never); // re-read after Claude's UPDATE
    mockResolveSession.mockResolvedValue({ serverId: "srv1", agentId: "agent1" });
    mockServerFindUnique.mockResolvedValueOnce({ host: "h", port: 22, username: "u", sshKeyPath: "/k" } as never);
    mockAgentFindUnique.mockResolvedValueOnce({ tmuxSession: "claude-agent-1" } as never);

    await generateProjectObjective("p1");

    expect(mockSendPrompt.mock.calls[0][2]).toBe("claude-agent-1");
  });
});
