/**
 * Tests for usage-poller critical behaviors:
 *   1. detectClaudeIdle returns tmuxMissing when the session doesn't exist
 *   2. Concurrent poll-cycle prevention via the globalThis running flag
 *   3. Queued task backoff (end-to-end: shouldSkip + recordFailure)
 *   4. Agent usage refresh — fetchClaudeUsageViaTmux with agent-specific session
 *   5. detectClaudeIdle with agent-specific session
 *   6. No duplicate agent dispatch — withServerDispatchLock serialization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── 1. detectClaudeIdle — missing tmux session ─────────────────────────────

vi.mock("@/lib/ssh", () => ({
  execSSH: vi.fn(),
}));

import { execSSH } from "@/lib/ssh";
import { detectClaudeIdle, fetchClaudeUsageViaTmux } from "../ssh-claude-tmux";

const mockExecSSH = vi.mocked(execSSH);

describe("detectClaudeIdle — tmux session missing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns tmuxMissing=true when capture-pane exits non-zero with 'can't find session'", async () => {
    mockExecSSH.mockResolvedValueOnce({
      stdout: "",
      stderr: "can't find session: claude",
      exitCode: 1,
    });

    const result = await detectClaudeIdle({
      host: "127.0.0.1",
      port: 22,
      username: "user",
      sshKeyPath: "/key",
    }, "claude");

    expect(result.isIdle).toBe(false);
    expect(result.tmuxMissing).toBe(true);
    expect(result.error).toMatch(/not found/);
  });

  it("returns tmuxMissing=true for 'no server running' error variant", async () => {
    mockExecSSH.mockResolvedValueOnce({
      stdout: "",
      stderr: "no server running on /tmp/tmux-1000/default",
      exitCode: 1,
    });

    const result = await detectClaudeIdle({
      host: "127.0.0.1",
      port: 22,
      username: "user",
      sshKeyPath: "/key",
    }, "claude");

    expect(result.isIdle).toBe(false);
    expect(result.tmuxMissing).toBe(true);
  });

  it("returns tmuxMissing=false for a generic non-zero exit (not a session error)", async () => {
    mockExecSSH.mockResolvedValueOnce({
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    });

    const result = await detectClaudeIdle({
      host: "127.0.0.1",
      port: 22,
      username: "user",
      sshKeyPath: "/key",
    }, "claude");

    expect(result.isIdle).toBe(false);
    expect(result.tmuxMissing).toBeFalsy();
  });

  it("returns isIdle=true when the pane shows the Claude prompt", async () => {
    const pane = [
      "Some previous output",
      "✓ Tool call completed",
      ">",
      " Claude 3.5 Sonnet | Auto",
    ].join("\n");

    mockExecSSH.mockResolvedValueOnce({
      stdout: pane,
      stderr: "",
      exitCode: 0,
    });

    const result = await detectClaudeIdle({
      host: "127.0.0.1",
      port: 22,
      username: "user",
      sshKeyPath: "/key",
    }, "claude");

    expect(result.isIdle).toBe(true);
    expect(result.tmuxMissing).toBeFalsy();
  });

  it("returns isIdle=false when Claude is visibly busy (spinner present)", async () => {
    const pane = [
      "Working on task...",
      "⠹ Thinking",
      ">",
    ].join("\n");

    mockExecSSH.mockResolvedValueOnce({
      stdout: pane,
      stderr: "",
      exitCode: 0,
    });

    const result = await detectClaudeIdle({
      host: "127.0.0.1",
      port: 22,
      username: "user",
      sshKeyPath: "/key",
    }, "claude");

    expect(result.isIdle).toBe(false);
    expect(result.tmuxMissing).toBeFalsy();
  });
});

// ─── 2. Concurrent poll prevention ──────────────────────────────────────────

describe("concurrent poll prevention", () => {
  it("skips a new tick while the previous one is still running", async () => {
    // Simulate the globalThis-based lock used in instrumentation.node.ts.
    const g = globalThis as { _pollerRunning?: boolean };
    const TAG = "[test-poller]";

    async function tick(runCheck: () => Promise<void>): Promise<boolean> {
      if (g._pollerRunning) return false; // skipped
      g._pollerRunning = true;
      try {
        await runCheck();
        return true;
      } finally {
        g._pollerRunning = false;
      }
    }

    let resolveFirst!: () => void;
    const firstComplete = new Promise<void>((res) => { resolveFirst = res; });

    const order: string[] = [];
    const firstCheck = async () => {
      order.push("first-start");
      await firstComplete;
      order.push("first-end");
    };
    const secondCheck = async () => { order.push("second-ran"); };

    // Start first tick (doesn't complete until we resolve the promise)
    const t1 = tick(firstCheck);

    // Second tick should be skipped because _pollerRunning is true
    const t2 = tick(secondCheck);

    // Finish the first tick
    resolveFirst();
    const [ran1, ran2] = await Promise.all([t1, t2]);

    expect(ran1).toBe(true);
    expect(ran2).toBe(false); // was skipped
    expect(order).toEqual(["first-start", "first-end"]);
    expect(order).not.toContain("second-ran");
  });

  it("allows a new tick after the previous one finishes", async () => {
    const g = globalThis as { _pollerRunning?: boolean };

    async function tick(runCheck: () => Promise<void>): Promise<boolean> {
      if (g._pollerRunning) return false;
      g._pollerRunning = true;
      try {
        await runCheck();
        return true;
      } finally {
        g._pollerRunning = false;
      }
    }

    const ran: string[] = [];
    await tick(async () => { ran.push("a"); });
    await tick(async () => { ran.push("b"); });

    expect(ran).toEqual(["a", "b"]);
    expect(g._pollerRunning).toBe(false);
  });
});

// ─── 3. Queued task backoff — end-to-end ────────────────────────────────────

import {
  shouldSkipDueToBackoff,
  recordDispatchFailure,
  clearDispatchBackoff,
  type BackoffEntry,
} from "../dispatch-backoff";

describe("queued task backoff — end-to-end", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not skip a task with no prior failures", () => {
    const store = new Map<string, BackoffEntry>();
    expect(shouldSkipDueToBackoff("task-1", store)).toBe(false);
  });

  it("skips the task immediately after a failure", () => {
    vi.setSystemTime(0);
    const store = new Map<string, BackoffEntry>();
    recordDispatchFailure("task-1", store);
    expect(shouldSkipDueToBackoff("task-1", store)).toBe(true);
  });

  it("retries after the backoff window expires", () => {
    vi.setSystemTime(0);
    const store = new Map<string, BackoffEntry>();
    recordDispatchFailure("task-1", store); // 60 s backoff

    vi.setSystemTime(60_001);
    expect(shouldSkipDueToBackoff("task-1", store)).toBe(false);
  });

  it("clears the backoff after a successful dispatch", () => {
    vi.setSystemTime(0);
    const store = new Map<string, BackoffEntry>();
    recordDispatchFailure("task-1", store);
    expect(shouldSkipDueToBackoff("task-1", store)).toBe(true);

    clearDispatchBackoff("task-1", store);
    expect(shouldSkipDueToBackoff("task-1", store)).toBe(false);
  });

  it("applies independent backoff per task", () => {
    vi.setSystemTime(0);
    const store = new Map<string, BackoffEntry>();
    recordDispatchFailure("task-a", store);

    expect(shouldSkipDueToBackoff("task-a", store)).toBe(true);
    expect(shouldSkipDueToBackoff("task-b", store)).toBe(false);
  });
});

// ─── 4. Agent usage refresh — fetchClaudeUsageViaTmux with agent session ────

const SSH_CONFIG = { host: "h", port: 22, username: "u", sshKeyPath: "/k" };

describe("fetchClaudeUsageViaTmux — agent-specific tmux session", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the agent session name in the has-session command, not 'claude'", async () => {
    // Session doesn't exist — returns early after first SSH call.
    mockExecSSH.mockResolvedValueOnce({ stdout: "no", stderr: "", exitCode: 0 });

    await fetchClaudeUsageViaTmux(SSH_CONFIG, "worker-agent-1");

    const cmd = mockExecSSH.mock.calls[0][1] as string;
    expect(cmd).toContain("worker-agent-1");
    expect(cmd).not.toMatch(/\bclaude\b/);
  });

  it("returns offline + 'not found' error when the agent session is missing", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "no", stderr: "", exitCode: 0 });

    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, "worker-agent-1");

    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
    expect(result.error).toMatch(/not found/);
  });

  it("returns parsed usage when the agent session exists and outputs usage data", async () => {
    const usagePane = [
      "Current session",
      "60% used",
      "Resets 3:10pm (UTC)",
      "",
      "Current week (all models)",
      "30% used",
      "Resets Jun 15, 9am (UTC)",
    ].join("\n");

    mockExecSSH
      .mockResolvedValueOnce({ stdout: "yes", stderr: "", exitCode: 0 })  // has-session
      .mockResolvedValueOnce({ stdout: ">", stderr: "", exitCode: 0 })     // pre-flight capture-pane
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })      // send /usage + sleep
      .mockResolvedValueOnce({ stdout: usagePane, stderr: "", exitCode: 0 }) // capture-pane after /usage
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });     // dismiss Escape

    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, "worker-agent-1");

    expect(result.success).toBe(true);
    expect(result.parsed.sessionPct).toBe(60);
    expect(result.parsed.weekPct).toBe(30);
  });
});

// ─── 5. detectClaudeIdle — agent-specific tmux session ──────────────────────

describe("detectClaudeIdle — agent-specific tmux session", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the agent session name in the capture-pane command", async () => {
    mockExecSSH.mockResolvedValueOnce({
      stdout: ">\n Claude 3.5 Sonnet | Auto",
      stderr: "",
      exitCode: 0,
    });

    await detectClaudeIdle(SSH_CONFIG, "worker-agent-1");

    const cmd = mockExecSSH.mock.calls[0][1] as string;
    expect(cmd).toContain("worker-agent-1");
  });

  it("returns tmuxMissing=true when the agent session is missing", async () => {
    mockExecSSH.mockResolvedValueOnce({
      stdout: "",
      stderr: "can't find session: worker-agent-1",
      exitCode: 1,
    });

    const result = await detectClaudeIdle(SSH_CONFIG, "worker-agent-1");

    expect(result.tmuxMissing).toBe(true);
    expect(result.isIdle).toBe(false);
  });

  it("returns isIdle=true when the agent session shows the Claude prompt", async () => {
    const pane = ["Some output", ">", " Claude 3.5 Sonnet | Auto"].join("\n");
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectClaudeIdle(SSH_CONFIG, "worker-agent-1");

    expect(result.isIdle).toBe(true);
    expect(result.tmuxMissing).toBeFalsy();
  });

  it("returns isIdle=false when the agent session shows a spinner", async () => {
    const pane = ["Working...", "⠹ Thinking", ">"].join("\n");
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectClaudeIdle(SSH_CONFIG, "worker-agent-1");

    expect(result.isIdle).toBe(false);
    expect(result.tmuxMissing).toBeFalsy();
  });
});

// ─── 7. Empty / missing tmuxSession guard ───────────────────────────────────

describe("fetchClaudeUsageViaTmux — empty tmuxSession guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns offline immediately for empty-string tmuxSession without any SSH call", async () => {
    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, "");

    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
    expect(result.error).toMatch(/not configured/i);
    expect(mockExecSSH).not.toHaveBeenCalled();
  });

  it("returns offline immediately for whitespace-only tmuxSession", async () => {
    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, "   ");

    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
    expect(mockExecSSH).not.toHaveBeenCalled();
  });
});

describe("detectClaudeIdle — empty tmuxSession guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns tmuxMissing=true immediately for empty-string tmuxSession without SSH call", async () => {
    const result = await detectClaudeIdle(SSH_CONFIG, "");

    expect(result.isIdle).toBe(false);
    expect(result.tmuxMissing).toBe(true);
    expect(result.error).toMatch(/not configured/i);
    expect(mockExecSSH).not.toHaveBeenCalled();
  });

  it("returns tmuxMissing=true immediately for whitespace-only tmuxSession", async () => {
    const result = await detectClaudeIdle(SSH_CONFIG, "  ");

    expect(result.isIdle).toBe(false);
    expect(result.tmuxMissing).toBe(true);
    expect(mockExecSSH).not.toHaveBeenCalled();
  });
});

// ─── 8. Multiple agents with different tmux sessions ─────────────────────────

describe("fetchClaudeUsageViaTmux — multiple agents with different sessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses each agent's own session name independently", async () => {
    // Both sessions are missing — each returns after one SSH call.
    mockExecSSH
      .mockResolvedValueOnce({ stdout: "no", stderr: "", exitCode: 0 }) // agent-1 has-session
      .mockResolvedValueOnce({ stdout: "no", stderr: "", exitCode: 0 }); // agent-2 has-session

    const [r1, r2] = await Promise.all([
      fetchClaudeUsageViaTmux(SSH_CONFIG, "claude-agent-1"),
      fetchClaudeUsageViaTmux(SSH_CONFIG, "claude-agent-2"),
    ]);

    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);

    const cmds = mockExecSSH.mock.calls.map(c => c[1] as string);
    expect(cmds.some(c => c.includes("claude-agent-1"))).toBe(true);
    expect(cmds.some(c => c.includes("claude-agent-2"))).toBe(true);
    // Neither should reference the literal string "claude" as a session name.
    expect(cmds.every(c => !c.match(/\s-t claude(\s|$)/))).toBe(true);
  });

  it("detects a renamed session as offline while the original stays online", async () => {
    const usagePane = [
      "Current session", "50% used", "Resets 3:10pm (UTC)", "",
      "Current week (all models)", "20% used", "Resets Jun 15, 9am (UTC)",
    ].join("\n");

    // claude-agent-1: session exists and returns usage data
    mockExecSSH
      .mockResolvedValueOnce({ stdout: "yes", stderr: "", exitCode: 0 })  // has-session
      .mockResolvedValueOnce({ stdout: ">", stderr: "", exitCode: 0 })    // pre-flight
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })     // send /usage
      .mockResolvedValueOnce({ stdout: usagePane, stderr: "", exitCode: 0 }) // capture
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });    // dismiss

    // claude-agent-renamed: session no longer exists
    mockExecSSH
      .mockResolvedValueOnce({ stdout: "no", stderr: "", exitCode: 0 }); // has-session

    // Run sequentially: the shared vi mock queue is consumed in call order,
    // so concurrent execution would interleave mock responses unpredictably.
    const online = await fetchClaudeUsageViaTmux(SSH_CONFIG, "claude-agent-1");
    const offline = await fetchClaudeUsageViaTmux(SSH_CONFIG, "claude-agent-renamed");

    expect(online.success).toBe(true);
    expect(online.parsed.sessionPct).toBe(50);

    expect(offline.success).toBe(false);
    expect(offline.status).toBe("offline");
    expect(offline.error).toMatch(/not found/);
  });
});

// ─── 9. Agent offline backoff ─────────────────────────────────────────────────

import {
  shouldSkipAgentOffline,
  recordAgentOffline,
  clearAgentOffline,
  AGENT_OFFLINE_BACKOFF_MS,
} from "../dispatch-backoff";

describe("agent offline backoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not skip a fresh agent with no offline record", () => {
    const store = new Map<string, number>();
    expect(shouldSkipAgentOffline("agent-1", store)).toBe(false);
  });

  it("skips the agent immediately after recording offline", () => {
    vi.setSystemTime(0);
    const store = new Map<string, number>();
    recordAgentOffline("agent-1", store);
    expect(shouldSkipAgentOffline("agent-1", store)).toBe(true);
  });

  it("stops skipping after the backoff window expires", () => {
    vi.setSystemTime(0);
    const store = new Map<string, number>();
    recordAgentOffline("agent-1", store);

    vi.setSystemTime(AGENT_OFFLINE_BACKOFF_MS + 1);
    expect(shouldSkipAgentOffline("agent-1", store)).toBe(false);
  });

  it("clears the backoff when the agent comes back online", () => {
    vi.setSystemTime(0);
    const store = new Map<string, number>();
    recordAgentOffline("agent-1", store);
    expect(shouldSkipAgentOffline("agent-1", store)).toBe(true);

    clearAgentOffline("agent-1", store);
    expect(shouldSkipAgentOffline("agent-1", store)).toBe(false);
  });

  it("applies independent backoff per agent id", () => {
    vi.setSystemTime(0);
    const store = new Map<string, number>();
    recordAgentOffline("agent-offline", store);

    expect(shouldSkipAgentOffline("agent-offline", store)).toBe(true);
    expect(shouldSkipAgentOffline("agent-online", store)).toBe(false);
  });

  it("accepts a custom backoff duration", () => {
    vi.setSystemTime(0);
    const store = new Map<string, number>();
    recordAgentOffline("agent-1", store, 10_000); // 10 s

    vi.setSystemTime(5_000);
    expect(shouldSkipAgentOffline("agent-1", store)).toBe(true);

    vi.setSystemTime(10_001);
    expect(shouldSkipAgentOffline("agent-1", store)).toBe(false);
  });
});

// ─── 6. No duplicate agent dispatch — withServerDispatchLock ────────────────

import { withServerDispatchLock } from "../dispatch-lock";

describe("withServerDispatchLock — no duplicate agent dispatch", () => {
  it("serializes concurrent calls for the same agent id", async () => {
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => { resolveFirst = r; });

    const p1 = withServerDispatchLock("agent-x", async () => {
      order.push("start-1");
      await firstDone;
      order.push("end-1");
    });
    // Enqueue p2 while p1 is still running.
    const p2 = withServerDispatchLock("agent-x", async () => {
      order.push("ran-2");
    });

    resolveFirst();
    await Promise.all([p1, p2]);

    // p2 must not start until p1 has fully completed.
    expect(order).toEqual(["start-1", "end-1", "ran-2"]);
  });

  it("allows concurrent calls for different agent ids", async () => {
    let resolveA!: () => void;
    const bCompleted = { value: false };

    const pA = withServerDispatchLock("agent-a", async () => {
      await new Promise<void>((r) => { resolveA = r; });
    });
    const pB = withServerDispatchLock("agent-b", async () => {
      bCompleted.value = true;
    });

    // pB (different key) should complete independently of pA.
    await pB;
    expect(bCompleted.value).toBe(true);

    resolveA();
    await pA;
  });

  it("propagates errors without poisoning the lock for subsequent callers", async () => {
    const p1 = withServerDispatchLock("agent-y", async () => {
      throw new Error("dispatch failed");
    });

    // p1 should reject.
    await expect(p1).rejects.toThrow("dispatch failed");

    // A subsequent call on the same id should still run.
    const ran = { value: false };
    const p2 = withServerDispatchLock("agent-y", async () => { ran.value = true; });
    await p2;
    expect(ran.value).toBe(true);
  });
});
