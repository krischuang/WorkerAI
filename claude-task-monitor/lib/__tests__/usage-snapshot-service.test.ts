/**
 * Tests for lib/usage-snapshot-service.ts — the single write path enforcing:
 *   1. Every refresh attempt is recorded as an AgentUsageSnapshot row, regardless of confidence.
 *   2. Agent.claudeSessionPct/claudeWeekPct (and related fields) are only updated when the
 *      result's parserConfidence is "high" or "medium" — never on "low" or "failed".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentUsageSnapshot: { create: vi.fn() },
    agent: { update: vi.fn() },
  },
}));

import { recordUsageSnapshot } from "../usage-snapshot-service";
import { prisma } from "@/lib/prisma";
import type { ReliableUsageResult } from "../ssh-claude-tmux";

const mockSnapshotCreate = vi.mocked(prisma.agentUsageSnapshot.create);
const mockAgentUpdate = vi.mocked(prisma.agent.update);

function buildResult(overrides: Partial<ReliableUsageResult> = {}): ReliableUsageResult {
  return {
    success: true,
    status: "ok",
    parsed: { sessionPct: 42, sessionResets: "3pm (Sydney)", weekPct: 12, weekResets: "Jun 15, 9am (Sydney)" },
    confidence: "high",
    warnings: [],
    rawOutput: "raw",
    cleanedOutput: "clean",
    source: "tmux_capture",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSnapshotCreate.mockResolvedValue({ id: "snap-1" } as never);
  mockAgentUpdate.mockResolvedValue({} as never);
});

describe("recordUsageSnapshot", () => {
  it("always creates an AgentUsageSnapshot row, even on failure", async () => {
    const failed = buildResult({ success: false, status: "error", confidence: "failed", parsed: {} });
    await recordUsageSnapshot("agent-1", failed, "tmux_capture");
    expect(mockSnapshotCreate).toHaveBeenCalledTimes(1);
    expect(mockSnapshotCreate.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ agentId: "agent-1", parserConfidence: "failed" }),
    });
  });

  it("updates Agent fields when confidence is high", async () => {
    const result = buildResult({ confidence: "high" });
    const { agentUpdated } = await recordUsageSnapshot("agent-1", result, "tmux_capture");
    expect(agentUpdated).toBe(true);
    expect(mockAgentUpdate).toHaveBeenCalledTimes(1);
    expect(mockAgentUpdate.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ claudeSessionPct: 42, claudeWeekPct: 12 }),
    });
  });

  it("updates Agent fields when confidence is medium", async () => {
    const result = buildResult({ confidence: "medium" });
    const { agentUpdated } = await recordUsageSnapshot("agent-1", result, "tmux_capture");
    expect(agentUpdated).toBe(true);
    expect(mockAgentUpdate.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ claudeSessionPct: 42 }),
    });
  });

  it("does NOT update Agent percentage fields when confidence is low", async () => {
    const result = buildResult({ confidence: "low", warnings: ["Captures disagreed"] });
    const { agentUpdated } = await recordUsageSnapshot("agent-1", result, "tmux_capture");
    expect(agentUpdated).toBe(false);
    expect(mockAgentUpdate).toHaveBeenCalledTimes(1);
    const data = mockAgentUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("claudeSessionPct");
    expect(data).not.toHaveProperty("claudeWeekPct");
    expect(data.claudeLastRefreshStatus).toBe("ok");
  });

  it("does NOT update Agent percentage fields when confidence is failed", async () => {
    const result = buildResult({ success: false, confidence: "failed", parsed: {}, status: "error" });
    const { agentUpdated } = await recordUsageSnapshot("agent-1", result, "tmux_capture");
    expect(agentUpdated).toBe(false);
    const data = mockAgentUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("claudeSessionPct");
    expect(data).not.toHaveProperty("claudeWeekPct");
  });

  it("never overwrites a previously-reliable value with a later low-confidence read", async () => {
    // First refresh: high confidence — Agent fields are updated to 42/12.
    const good = buildResult({ confidence: "high" });
    await recordUsageSnapshot("agent-1", good, "tmux_capture");
    expect(mockAgentUpdate.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ claudeSessionPct: 42, claudeWeekPct: 12 }),
    });

    mockAgentUpdate.mockClear();

    // Second refresh: low confidence with different (possibly wrong) numbers — must not
    // be written to the Agent row at all, leaving the prior reliable values intact.
    const bad = buildResult({
      confidence: "low",
      parsed: { sessionPct: 99, weekPct: 99 },
      warnings: ["Captures disagreed on session %: 42, 99."],
    });
    const { agentUpdated } = await recordUsageSnapshot("agent-1", bad, "tmux_capture");
    expect(agentUpdated).toBe(false);
    const data = mockAgentUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("claudeSessionPct");
    expect(data).not.toHaveProperty("claudeWeekPct");
  });

  it("records the source passed in (manual_refresh, pipe_pane, tmux_capture)", async () => {
    await recordUsageSnapshot("agent-1", buildResult(), "manual_refresh");
    expect(mockSnapshotCreate.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ source: "manual_refresh" }),
    });
  });

  it("stores parseWarnings on the snapshot even when confidence is high", async () => {
    const result = buildResult({ confidence: "high", warnings: ["minor note"] });
    await recordUsageSnapshot("agent-1", result, "tmux_capture");
    expect(mockSnapshotCreate.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ parseWarnings: ["minor note"] }),
    });
  });
});
