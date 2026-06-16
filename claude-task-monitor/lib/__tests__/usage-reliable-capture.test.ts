/**
 * Tests for fetchClaudeUsageReliable (lib/ssh-claude-tmux.ts) — the multi-capture pipeline that
 * sends /usage, captures the pane RELIABLE_CAPTURE_COUNT times, and only reports a confidence
 * level once all captures have been cross-checked by assessParseConfidence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ssh", () => ({
  execSSH: vi.fn(),
}));

import { execSSH } from "@/lib/ssh";
import { fetchClaudeUsageReliable } from "../ssh-claude-tmux";

const mockExecSSH = vi.mocked(execSSH);

const SSH_CONFIG = { host: "127.0.0.1", port: 22, username: "user", sshKeyPath: "/key" };
const SESSION = "claude";

function ok(stdout: string) {
  return Promise.resolve({ stdout, stderr: "", exitCode: 0 });
}

const USAGE_TEXT = [
  "Current session",
  "████████ 42% used",
  "Resets 3pm (UTC)",
  "",
  "Current week (all models)",
  "██ 12% used",
  "Resets Jun 15, 9am (UTC)",
].join("\n");

const USAGE_TEXT_VARIANT = USAGE_TEXT.replace("42% used", "47% used");

beforeEach(() => vi.clearAllMocks());

describe("fetchClaudeUsageReliable — guards", () => {
  it("returns failed confidence immediately for an empty tmuxSession, with no SSH calls", async () => {
    const result = await fetchClaudeUsageReliable(SSH_CONFIG, "", "tmux_capture");
    expect(result.success).toBe(false);
    expect(result.confidence).toBe("failed");
    expect(mockExecSSH).not.toHaveBeenCalled();
  });

  it("returns offline status when the tmux session does not exist", async () => {
    mockExecSSH.mockImplementationOnce(() => ok("no")); // has-session
    const result = await fetchClaudeUsageReliable(SSH_CONFIG, SESSION, "tmux_capture");
    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
    expect(result.confidence).toBe("failed");
  });
});

describe("fetchClaudeUsageReliable — successful multi-capture", () => {
  it("returns high confidence when all three captures agree", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))        // has-session
      .mockImplementationOnce(() => ok(""))            // blank Enter
      .mockImplementationOnce(() => ok(">\n"))         // preflight capture (idle, clean)
      .mockImplementationOnce(() => ok(""))            // send /usage
      .mockImplementationOnce(() => ok(USAGE_TEXT))    // capture 1
      .mockImplementationOnce(() => ok(USAGE_TEXT))    // capture 2
      .mockImplementationOnce(() => ok(USAGE_TEXT))    // capture 3
      .mockImplementationOnce(() => ok(""));           // dismiss Escape

    const result = await fetchClaudeUsageReliable(SSH_CONFIG, SESSION, "tmux_capture");

    expect(result.success).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.parsed.sessionPct).toBe(42);
    expect(result.parsed.weekPct).toBe(12);
    expect(result.source).toBe("tmux_capture");
  }, 10_000);

  it("returns low confidence when captures disagree (TUI mid-redraw)", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok(">\n"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok(USAGE_TEXT))         // capture 1: 42%
      .mockImplementationOnce(() => ok(USAGE_TEXT_VARIANT)) // capture 2: 47%
      .mockImplementationOnce(() => ok(USAGE_TEXT))         // capture 3: 42%
      .mockImplementationOnce(() => ok(""));

    const result = await fetchClaudeUsageReliable(SSH_CONFIG, SESSION, "tmux_capture");

    expect(result.success).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.warnings.some((w) => /disagreed/.test(w))).toBe(true);
  }, 10_000);

  it("returns failed when none of the captures look like usage output", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok(">\n"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok("$ \n"))
      .mockImplementationOnce(() => ok("$ \n"))
      .mockImplementationOnce(() => ok("$ \n"))
      .mockImplementationOnce(() => ok(""));

    const result = await fetchClaudeUsageReliable(SSH_CONFIG, SESSION, "tmux_capture");

    expect(result.success).toBe(false);
    expect(result.confidence).toBe("failed");
  }, 10_000);
});
