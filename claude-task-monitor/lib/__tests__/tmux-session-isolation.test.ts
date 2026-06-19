/**
 * P3-6: Agent Session Isolation
 *
 * Verifies that:
 *   1. With TMUX_SESSION_SECRET set, opaqueSessionName generates HMAC-based names.
 *   2. Session names are not guessable from the taskId.
 *   3. The same taskId always produces the same name (deterministic).
 *   4. Different taskIds produce different names.
 *   5. Session names are tmux-safe (alphanumeric + limited punctuation).
 *   6. Without the env var, fallback to "claude_<taskId>" format.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const originalSecret = process.env.TMUX_SESSION_SECRET;

async function importFresh() {
  // Force fresh module import to pick up env var changes.
  const mod = await import("../tmux-session?ts=" + Date.now());
  return mod;
}

describe("opaqueSessionName — with TMUX_SESSION_SECRET", () => {
  beforeEach(() => {
    process.env.TMUX_SESSION_SECRET = "0".repeat(64); // valid 32-byte hex
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.TMUX_SESSION_SECRET;
    } else {
      process.env.TMUX_SESSION_SECRET = originalSecret;
    }
  });

  it("returns a string that does NOT contain the taskId directly", async () => {
    const { opaqueSessionName } = await importFresh();
    const taskId = "cmq6m90ns0015mm5u5zp5zjwn";
    const name = opaqueSessionName(taskId);
    expect(name).not.toContain(taskId);
    expect(name).not.toBe(`claude_${taskId}`);
  });

  it("is deterministic — same input produces same output", async () => {
    const { opaqueSessionName } = await importFresh();
    const taskId = "test-task-123";
    expect(opaqueSessionName(taskId)).toBe(opaqueSessionName(taskId));
  });

  it("different taskIds produce different session names", async () => {
    const { opaqueSessionName } = await importFresh();
    const nameA = opaqueSessionName("task-a");
    const nameB = opaqueSessionName("task-b");
    expect(nameA).not.toBe(nameB);
  });

  it("session name is tmux-safe (starts with letter/number)", async () => {
    const { opaqueSessionName } = await importFresh();
    const name = opaqueSessionName("some-task-id");
    expect(name).toMatch(/^[a-z0-9]/);
  });

  it("session name length is reasonable for tmux (<= 64 chars)", async () => {
    const { opaqueSessionName } = await importFresh();
    const name = opaqueSessionName("cmq6m90ns0015mm5u5zp5zjwn");
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("opaqueSessionName — without TMUX_SESSION_SECRET (fallback)", () => {
  beforeEach(() => {
    delete process.env.TMUX_SESSION_SECRET;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.TMUX_SESSION_SECRET = originalSecret;
    }
  });

  it("falls back to claude_<taskId> format", async () => {
    const { opaqueSessionName } = await importFresh();
    const taskId = "test-fallback";
    const name = opaqueSessionName(taskId);
    expect(name).toBe(`claude_${taskId}`);
  });
});

describe("isSessionNameForTask", () => {
  beforeEach(() => {
    process.env.TMUX_SESSION_SECRET = "a".repeat(64);
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.TMUX_SESSION_SECRET;
    } else {
      process.env.TMUX_SESSION_SECRET = originalSecret;
    }
  });

  it("returns true when session name was derived from the taskId", async () => {
    const { opaqueSessionName, isSessionNameForTask } = await importFresh();
    const taskId = "verify-me";
    const name = opaqueSessionName(taskId);
    expect(isSessionNameForTask(name, taskId)).toBe(true);
  });

  it("returns false when session name does not match", async () => {
    const { isSessionNameForTask } = await importFresh();
    expect(isSessionNameForTask("wrong-name", "my-task")).toBe(false);
  });
});
