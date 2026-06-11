/**
 * Tests for the pipe-pane-based Claude usage monitor:
 *   - stripAnsi (ANSI cleanup)
 *   - parseUsage with usageCreditsEnabled
 *   - fetchClaudeUsageViaPipePaneTmux (mocked SSH)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  stripAnsi,
  cleanPane,
  parseUsage,
  looksLikeUsage,
} from "../usage-parser";

// ─── stripAnsi ────────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes CSI color sequences", () => {
    expect(stripAnsi("\x1b[31mRed text\x1b[0m")).toBe("Red text");
  });

  it("removes CSI cursor-positioning sequences", () => {
    expect(stripAnsi("\x1b[1;10H cursor moved")).toBe(" cursor moved");
  });

  it("removes CSI erase-line sequences", () => {
    expect(stripAnsi("line\x1b[2Kend")).toBe("lineend");
  });

  it("removes OSC sequences (window title)", () => {
    expect(stripAnsi("\x1b]0;terminal title\x07normal")).toBe("normal");
  });

  it("removes OSC sequences terminated by ST (ESC \\)", () => {
    expect(stripAnsi("\x1b]2;My Terminal\x1b\\text")).toBe("text");
  });

  it("removes Fe/Fs escape sequences (ESC + single letter)", () => {
    // ESC = (DECPAM), ESC M (Reverse Index), etc. — both ESC and the following char removed
    expect(stripAnsi("\x1b=hello")).toBe("hello");
    expect(stripAnsi("pre\x1bMpost")).toBe("prepost");
  });

  it("removes trailing stray ESC (not followed by any char)", () => {
    // Final pass strips any remaining bare ESC bytes
    expect(stripAnsi("before\x1b")).toBe("before");
  });

  it("removes carriage returns", () => {
    expect(stripAnsi("line1\r\nline2")).toBe("line1\nline2");
  });

  it("removes NUL bytes and other non-printable control chars", () => {
    expect(stripAnsi("a\x00b\x07c\x0ed")).toBe("abcd");
  });

  it("preserves newlines (\\n)", () => {
    const result = stripAnsi("line1\nline2");
    expect(result).toBe("line1\nline2");
  });

  it("preserves plain ASCII text unchanged", () => {
    expect(stripAnsi("Current week (all models)\n17% used")).toBe(
      "Current week (all models)\n17% used"
    );
  });

  it("handles complex real-world pipe-pane output containing usage text", () => {
    // Simulates TUI output: cursor movement + colors + usage text
    const raw =
      "\x1b[?1049h\x1b[H\x1b[2J" +               // alt screen + clear
      "\x1b[1;1HCurrent week (all models)\n" +     // cursor pos + text
      "\x1b[32m█████\x1b[0m           17% used\n" + // colored bar
      "Resets Jun 15, 9am (UTC)\n" +
      "\x1b[?1049l";                               // exit alt screen

    const cleaned = cleanPane(stripAnsi(raw));
    expect(looksLikeUsage(cleaned)).toBe(true);
    expect(cleaned).toContain("17% used");
    expect(cleaned).toContain("Jun 15, 9am");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("handles string with only ANSI codes", () => {
    expect(stripAnsi("\x1b[31m\x1b[0m\x1b[?1049h\x1b[?1049l")).toBe("");
  });
});

// ─── parseUsage — usageCreditsEnabled ─────────────────────────────────────────

describe("parseUsage — usageCreditsEnabled", () => {
  const BASE = `
Current week (all models)
█████           17% used
Resets Jun 15, 9am (UTC)
`.trim();

  it("returns undefined when no credits mention in output", () => {
    const result = parseUsage(BASE);
    expect(result.usageCreditsEnabled).toBeUndefined();
  });

  it("returns false when 'Usage credits are off' is present", () => {
    const result = parseUsage(`${BASE}\nUsage credits are off`);
    expect(result.usageCreditsEnabled).toBe(false);
  });

  it("returns true when 'Usage credits are on' is present", () => {
    const result = parseUsage(`${BASE}\nUsage credits are on`);
    expect(result.usageCreditsEnabled).toBe(true);
  });

  it("is case-insensitive for credits detection", () => {
    expect(parseUsage("USAGE CREDITS ARE OFF").usageCreditsEnabled).toBe(false);
    expect(parseUsage("USAGE CREDITS ARE ON").usageCreditsEnabled).toBe(true);
  });

  it("credits off takes precedence over on when both appear (first match)", () => {
    // Both patterns in same text — 'off' check runs first in the implementation
    const result = parseUsage("Usage credits are off\nUsage credits are on");
    expect(result.usageCreditsEnabled).toBe(false);
  });

  it("still parses week percentage alongside credits status", () => {
    const result = parseUsage(`${BASE}\nUsage credits are off`);
    expect(result.weekPct).toBe(17);
    expect(result.usageCreditsEnabled).toBe(false);
  });
});

// ─── fetchClaudeUsageViaPipePaneTmux — mocked SSH ────────────────────────────

// We mock lib/ssh so no real SSH connections are made.
vi.mock("../ssh", () => ({
  execSSH: vi.fn(),
}));

import { fetchClaudeUsageViaPipePaneTmux } from "../ssh-claude-tmux";
import * as sshModule from "../ssh";

const mockExecSSH = vi.mocked(sshModule.execSSH);

const SSH_CONFIG = { host: "localhost", port: 22, username: "test", sshKeyPath: "/tmp/key" };
const SESSION = "claude_agent1";

/** Build a mock execSSH that sequences through responses for each call. */
function mockSSHSequence(responses: Array<Partial<{ stdout: string; stderr: string; exitCode: number }> | Error>) {
  let call = 0;
  mockExecSSH.mockImplementation(async () => {
    const resp = responses[Math.min(call++, responses.length - 1)];
    if (resp instanceof Error) throw resp;
    return { stdout: "", stderr: "", exitCode: 0, ...resp };
  });
}

beforeEach(() => { mockExecSSH.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const USAGE_OUTPUT = `
Current session
100% used
Resets 3:10pm (UTC)

Current week (all models)
17% used
Resets Jun 15, 9am (UTC)

Usage credits are off
`.trim();

describe("fetchClaudeUsageViaPipePaneTmux", () => {
  it("returns offline immediately when tmuxSession is empty", async () => {
    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, "");
    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
    expect(mockExecSSH).not.toHaveBeenCalled();
  });

  it("returns offline when tmuxSession is blank whitespace", async () => {
    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, "   ");
    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
  });

  it("returns offline when SSH connection fails", async () => {
    mockExecSSH.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
    expect(result.error).toContain("Connection refused");
  });

  it("returns offline when tmux session does not exist", async () => {
    mockSSHSequence([
      { stdout: "no" },  // has-session check
    ]);
    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(false);
    expect(result.status).toBe("offline");
    expect(result.error).toContain("not found");
  });

  it("returns auth_required when pre-flight detects login prompt", async () => {
    mockSSHSequence([
      { stdout: "yes" },                          // has-session
      { stdout: "not logged in\nRun claude login" }, // capture-pane preflight
      // No more calls expected
    ]);
    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(false);
    expect(result.status).toBe("auth_required");
  });

  it("returns rate_limited when pre-flight detects rate limit", async () => {
    mockSSHSequence([
      { stdout: "yes" },                           // has-session
      { stdout: "rate_limit_error\ntoo many requests" }, // capture-pane preflight
    ]);
    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(false);
    expect(result.status).toBe("rate_limited");
  });

  it("successfully captures and parses usage data", async () => {
    mockSSHSequence([
      { stdout: "yes" },           // has-session
      { stdout: ">" },             // capture-pane preflight (idle, clean)
      { stdout: "" },              // pipe-pane enable + send + sleep
      { stdout: "" },              // pipe-pane disable
      { stdout: USAGE_OUTPUT },    // cat tmpFile
      { stdout: "" },              // rm tmpFile
      { stdout: "" },              // Escape + sleep
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.parsed.weekPct).toBe(17);
    expect(result.parsed.sessionPct).toBe(100);
    expect(result.parsed.usageCreditsEnabled).toBe(false);
  });

  it("parses usage percentage from cleaned output", async () => {
    const output = "Current week (all models)\n42% used\nResets Jun 20, 9am (UTC)";
    mockSSHSequence([
      { stdout: "yes" },     // has-session
      { stdout: ">" },       // preflight
      { stdout: "" },        // pipe-pane+send+sleep
      { stdout: "" },        // pipe-pane disable
      { stdout: output },    // cat tmpFile
      { stdout: "" },        // rm
      { stdout: "" },        // Escape
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(true);
    expect(result.parsed.weekPct).toBe(42);
  });

  it("parses reset time from cleaned output", async () => {
    const output = "Current week (all models)\n17% used\nResets Jun 15, 9am (UTC)";
    mockSSHSequence([
      { stdout: "yes" },
      { stdout: ">" },
      { stdout: "" },
      { stdout: "" },
      { stdout: output },
      { stdout: "" },
      { stdout: "" },
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(true);
    expect(result.parsed.weekResets).toContain("Jun");
    expect(result.parsed.weekResetsAt).toBeInstanceOf(Date);
  });

  it("strips ANSI codes before parsing (real TUI output simulation)", async () => {
    // Simulate pipe-pane capturing cursor-pos + color codes around usage text
    const ansiOutput =
      "\x1b[?1049h\x1b[H\x1b[2JCurrent week (all models)\n" +
      "\x1b[32m██\x1b[0m     17% used\nResets Jun 15, 9am (UTC)\x1b[?1049l";

    mockSSHSequence([
      { stdout: "yes" },
      { stdout: ">" },
      { stdout: "" },
      { stdout: "" },
      { stdout: ansiOutput },
      { stdout: "" },
      { stdout: "" },
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(true);
    expect(result.parsed.weekPct).toBe(17);
    expect(result.cleanedOutput).not.toContain("\x1b");
  });

  it("returns error with empty cleaned output when capture is empty", async () => {
    mockSSHSequence([
      { stdout: "yes" },
      { stdout: ">" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },   // empty capture
      { stdout: "" },
      { stdout: "" },
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.parsed.weekPct).toBeUndefined();
    expect(result.parsed.sessionPct).toBeUndefined();
  });

  it("returns error on malformed / unrecognised output", async () => {
    const garbage = "some random output\nthat has no usage data\nfoo bar baz";
    mockSSHSequence([
      { stdout: "yes" },
      { stdout: ">" },
      { stdout: "" },
      { stdout: "" },
      { stdout: garbage },
      { stdout: "" },
      { stdout: "" },
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    // Never interpret missing data as 0%
    expect(result.parsed.weekPct).toBeUndefined();
    expect(result.parsed.sessionPct).toBeUndefined();
  });

  it("never returns 0% usage when parsing fails (missing-data guard)", async () => {
    mockSSHSequence([
      { stdout: "yes" },
      { stdout: ">" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "not usage data at all" },
      { stdout: "" },
      { stdout: "" },
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    // success=false → parsed is empty object, no 0% implied
    expect(result.parsed.weekPct).toBeUndefined();
    expect(result.parsed.sessionPct).toBeUndefined();
    // Caller must not treat undefined as 0
    expect(result.parsed.weekPct ?? null).toBeNull();
  });

  it("returns error with populated cleanedOutput field", async () => {
    const output = "Current week (all models)\n99% used\nResets 9am (UTC)";
    mockSSHSequence([
      { stdout: "yes" },
      { stdout: ">" },
      { stdout: "" },
      { stdout: "" },
      { stdout: output },
      { stdout: "" },
      { stdout: "" },
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.cleanedOutput.length).toBeGreaterThan(0);
    expect(result.rawOutput.length).toBeGreaterThan(0);
  });

  it("returns error status when capture SSH call throws (timeout simulation)", async () => {
    mockSSHSequence([
      { stdout: "yes" },                      // has-session
      { stdout: ">" },                        // preflight
      new Error("SSH timeout after 14000ms"), // pipe-pane+send+sleep throws
    ]);

    const result = await fetchClaudeUsageViaPipePaneTmux(SSH_CONFIG, SESSION);
    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Capture failed");
  });
});
