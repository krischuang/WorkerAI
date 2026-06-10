/**
 * Tests for the per-task tmux session naming convention introduced to support
 * parallel task execution on a single server (TICKET-004).
 *
 * Covers:
 *   • taskTmuxSessionName — the naming function exported by ssh-claude-tmux
 *   • taskTmuxSessionName re-exported from task-dispatch
 *   • Session name properties (uniqueness, format, tmux-safe characters)
 */

import { describe, it, expect } from "vitest";
import { taskTmuxSessionName } from "../ssh-claude-tmux";

// ─── Session naming ───────────────────────────────────────────────────────────

describe("taskTmuxSessionName", () => {
  it("prefixes the taskId with 'claude_'", () => {
    expect(taskTmuxSessionName("abc123")).toBe("claude_abc123");
  });

  it("produces unique names for different task IDs", () => {
    const ids = ["task1", "task2", "task3"];
    const names = ids.map(taskTmuxSessionName);
    const unique = new Set(names);
    expect(unique.size).toBe(ids.length);
  });

  it("produces the same name for the same task ID (deterministic)", () => {
    const id = "cmq6m90ns0015mm5u5zp5zjwn";
    expect(taskTmuxSessionName(id)).toBe(taskTmuxSessionName(id));
  });

  it("session name contains only safe characters (alphanumeric + underscore)", () => {
    // tmux session names should be safe for command-line use without quoting
    const name = taskTmuxSessionName("cmq6m90ns0015mm5u5zp5zjwn");
    expect(name).toMatch(/^[a-z0-9_]+$/);
  });

  it("handles a realistic CUID task ID", () => {
    const cuid = "cmq6m90ns0015mm5u5zp5zjwn";
    const name = taskTmuxSessionName(cuid);
    expect(name).toBe(`claude_${cuid}`);
    expect(name.length).toBeLessThan(64); // well within tmux limits
  });

  it("works with short/test IDs too", () => {
    expect(taskTmuxSessionName("t1")).toBe("claude_t1");
  });
});

// ─── Naming invariants ────────────────────────────────────────────────────────

describe("taskTmuxSessionName — naming invariants", () => {
  it("never collides with the server management session named 'claude'", () => {
    // The server's base management session is named "claude".
    // Per-task sessions are "claude_<taskId>" — always longer.
    const name = taskTmuxSessionName("anytask");
    expect(name).not.toBe("claude");
    expect(name.startsWith("claude_")).toBe(true);
  });

  it("never collides with agent session names (agents use arbitrary names set by user)", () => {
    // Agent sessions are named by the user (e.g. "my-agent").
    // Per-task sessions always start with "claude_" which agents typically don't.
    const taskName = taskTmuxSessionName("cmq6m9abc");
    expect(taskName).toMatch(/^claude_/);
  });

  it("two different tasks always produce different session names", () => {
    const pairs: Array<[string, string]> = [
      ["task-a", "task-b"],
      ["cmq6m90ns0015mm5u", "cmq6m90ns0016mm5u"],
      ["t1", "t2"],
    ];
    for (const [id1, id2] of pairs) {
      expect(taskTmuxSessionName(id1)).not.toBe(taskTmuxSessionName(id2));
    }
  });
});

// ─── Re-export consistency ────────────────────────────────────────────────────

describe("taskTmuxSessionName re-exported from task-dispatch", () => {
  it("re-export produces identical results to the original", async () => {
    // task-dispatch re-exports the function — verify it's the same function.
    const { taskTmuxSessionName: fromDispatch } = await import("../task-dispatch");
    const id = "cmq6m90ns0015mm5u5zp5zjwn";
    expect(fromDispatch(id)).toBe(taskTmuxSessionName(id));
  });
});
