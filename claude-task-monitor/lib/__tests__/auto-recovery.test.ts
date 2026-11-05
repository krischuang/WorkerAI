/**
 * Tests for lib/auto-recovery.ts's kill-switch enforcement.
 *
 * Found during the Demo Day security pass: runAutoRecovery/recoverServer/
 * recoverAgent relaunch Claude sessions over SSH but never checked the kill
 * switch — "selfHealing" is explicitly one of its scopes (lib/kill-switch.ts),
 * but nothing enforced it here. An active kill switch must stop this,
 * whether the recovery was triggered automatically or by a human clicking
 * "recover" in the UI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    server: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    agent: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    recoveryLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/ssh-claude-tmux", () => ({
  launchClaudeInTmux: vi.fn(),
}));

vi.mock("@/lib/kill-switch", () => ({
  isSubsystemHalted: vi.fn().mockResolvedValue(false),
}));

import { recoverServer, recoverAgent } from "../auto-recovery";
import { prisma } from "@/lib/prisma";
import { launchClaudeInTmux } from "@/lib/ssh-claude-tmux";
import { isSubsystemHalted } from "@/lib/kill-switch";

const mockServer = vi.mocked(prisma.server);
const mockAgent = vi.mocked(prisma.agent);
const mockTransaction = vi.mocked(prisma.$transaction);
const mockLaunch = vi.mocked(launchClaudeInTmux);
const mockIsSubsystemHalted = vi.mocked(isSubsystemHalted);

const SERVER_ROW = {
  id: "server-1", name: "worker-1", host: "h", port: 22, username: "u", sshKeyPath: "/k",
  tmuxSession: "claude", claudePermissionMode: "workspace_write",
  autoRecovery: true, recoveryAttempts: 0, maxRecoveryAttempts: 3,
  _count: { tasks: 0 },
};

const AGENT_ROW = {
  id: "agent-1", name: "agent-1", tmuxSession: "claude-agent-1", workDir: "/home/demo",
  claudePermissionMode: "workspace_write",
  autoRecovery: true, recoveryAttempts: 0, maxRecoveryAttempts: 3,
  server: { host: "h", port: 22, username: "u", sshKeyPath: "/k" },
  _count: { tasks: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSubsystemHalted.mockResolvedValue(false);
  mockTransaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
  mockLaunch.mockResolvedValue({ success: true, command: "claude" } as never);
});

describe("recoverServer — kill switch enforcement", () => {
  it("SECURITY: refuses to relaunch Claude when the kill switch's selfHealing scope is active (manual trigger)", async () => {
    mockIsSubsystemHalted.mockResolvedValue(true);

    const result = await recoverServer("server-1", "manual");

    expect(result).toEqual({ attempted: false, success: false, reason: "kill_switch_active" });
    expect(mockIsSubsystemHalted).toHaveBeenCalledWith("selfHealing");
    expect(mockServer.findUnique).not.toHaveBeenCalled();
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("SECURITY: also refuses for an auto-triggered recovery", async () => {
    mockIsSubsystemHalted.mockResolvedValue(true);

    const result = await recoverServer("server-1", "auto");

    expect(result.attempted).toBe(false);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("proceeds normally when the kill switch is not active", async () => {
    mockServer.findUnique.mockResolvedValueOnce(SERVER_ROW as never);

    const result = await recoverServer("server-1", "manual");

    expect(result.attempted).toBe(true);
    expect(mockLaunch).toHaveBeenCalledTimes(1);
  });
});

describe("recoverAgent — kill switch enforcement", () => {
  it("SECURITY: refuses to relaunch Claude when the kill switch's selfHealing scope is active", async () => {
    mockIsSubsystemHalted.mockResolvedValue(true);

    const result = await recoverAgent("agent-1", "manual");

    expect(result).toEqual({ attempted: false, success: false, reason: "kill_switch_active" });
    expect(mockAgent.findUnique).not.toHaveBeenCalled();
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("proceeds normally when the kill switch is not active", async () => {
    mockAgent.findUnique.mockResolvedValueOnce(AGENT_ROW as never);

    const result = await recoverAgent("agent-1", "manual");

    expect(result.attempted).toBe(true);
    expect(mockLaunch).toHaveBeenCalledTimes(1);
  });
});
