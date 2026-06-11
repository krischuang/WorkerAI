/**
 * Tests for the rate-limit false-positive fix in fetchClaudeUsageViaTmux.
 *
 * The fix: before capturing the tmux pane for the preflight check, send a
 * blank Enter keystroke to the pane.  This pushes any stale content (e.g. a
 * rate-limit error left by a previous task) into the scrollback buffer so it
 * falls outside the tail window that classifyPreflightPane scans.
 *
 * Invariants verified here:
 *  1. The blank Enter is sent BEFORE the first capture-pane call.
 *  2. A true-positive rate-limit (text still in the fresh tail) is still
 *     detected and returned as { status: "rate_limited" }.
 *  3. A false-positive is prevented: a clean pane after the blank Enter does
 *     NOT produce status "rate_limited"; the function proceeds to /usage.
 *  4. A network failure on the blank Enter is silenced and does not abort
 *     the function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ssh", () => ({
  execSSH: vi.fn(),
}));

import { execSSH } from "@/lib/ssh";
import { fetchClaudeUsageViaTmux } from "../ssh-claude-tmux";

const mockExecSSH = vi.mocked(execSSH);

const SSH_CONFIG = { host: "127.0.0.1", port: 22, username: "user", sshKeyPath: "/key" };
const SESSION = "claude";

function ok(stdout: string) {
  return Promise.resolve({ stdout, stderr: "", exitCode: 0 });
}

function fail(message: string) {
  return Promise.reject(new Error(message));
}

describe("fetchClaudeUsageViaTmux — blank-Enter preflight fix", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a blank Enter before the first capture-pane call", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))     // has-session
      .mockImplementationOnce(() => ok(""))         // blank Enter + sleep
      .mockImplementationOnce(() => ok(">\n"))      // capture-pane (clean pane)
      .mockImplementationOnce(() => fail("short-circuit")); // /usage send

    await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    const cmds = mockExecSSH.mock.calls.map(([, cmd]) => cmd as string);

    const blankEnterIdx = cmds.findIndex((c) => c.includes('"" Enter'));
    const capturePaneIdx = cmds.findIndex((c) => c.includes("capture-pane"));

    expect(blankEnterIdx).toBeGreaterThan(-1);
    expect(capturePaneIdx).toBeGreaterThan(-1);
    expect(blankEnterIdx).toBeLessThan(capturePaneIdx);
  });

  it("blank Enter targets the correct tmux session", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok(">\n"))
      .mockImplementationOnce(() => fail("short-circuit"));

    await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    const cmds = mockExecSSH.mock.calls.map(([, cmd]) => cmd as string);
    const blankEnterCmd = cmds.find((c) => c.includes('"" Enter'));
    expect(blankEnterCmd).toContain(`-t ${SESSION}`);
  });
});

describe("fetchClaudeUsageViaTmux — rate-limit true-positive still detected", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns rate_limited when pane tail contains rate_limit_error after the blank Enter", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))   // has-session
      .mockImplementationOnce(() => ok(""))       // blank Enter
      .mockImplementationOnce(() => ok(           // capture-pane: rate-limit in fresh tail
        "  Error: rate_limit_error\n  Too many requests. Please wait.\n>"
      ));

    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    expect(result.success).toBe(false);
    expect(result.status).toBe("rate_limited");
  });

  it("does NOT send /usage when rate-limit is detected at preflight", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok("  rate-limit exceeded — retry in 60 s\n>"));

    await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    const usageSent = mockExecSSH.mock.calls.some(([, cmd]) =>
      (cmd as string).includes("/usage")
    );
    expect(usageSent).toBe(false);
  });

  it("detects 'too many requests' variant as rate_limited", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok("  Too many requests — please wait.\n>"));

    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    expect(result.status).toBe("rate_limited");
  });
});

describe("fetchClaudeUsageViaTmux — false-positive prevention", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT return rate_limited when pane tail is clean after the blank Enter", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))   // has-session
      .mockImplementationOnce(() => ok(""))       // blank Enter (stale content pushed out)
      .mockImplementationOnce(() => ok(">\n"))    // capture-pane: clean idle pane
      .mockImplementationOnce(() => fail("short-circuit")); // /usage — short-circuit test

    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    expect(result.status).not.toBe("rate_limited");
  });

  it("proceeds to send /usage when preflight pane is clean", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))
      .mockImplementationOnce(() => ok(""))
      .mockImplementationOnce(() => ok(">\n"))
      .mockImplementationOnce(() => fail("short-circuit"));

    await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    const usageSent = mockExecSSH.mock.calls.some(([, cmd]) =>
      (cmd as string).includes("/usage")
    );
    expect(usageSent).toBe(true);
  });
});

describe("fetchClaudeUsageViaTmux — blank Enter error resilience", () => {
  beforeEach(() => vi.clearAllMocks());

  it("silences a network failure on the blank Enter and continues", async () => {
    mockExecSSH
      .mockImplementationOnce(() => ok("yes"))                     // has-session
      .mockImplementationOnce(() => fail("connection reset"))       // blank Enter throws
      .mockImplementationOnce(() => ok(">\n"))                      // capture-pane: clean
      .mockImplementationOnce(() => fail("short-circuit"));         // /usage

    // Must not throw
    const result = await fetchClaudeUsageViaTmux(SSH_CONFIG, SESSION);

    // Not aborted at the blank-Enter stage
    expect(result.status).not.toBe("offline");
    expect(result.status).not.toBe("rate_limited");

    // Capture-pane and /usage were still attempted
    const cmds = mockExecSSH.mock.calls.map(([, cmd]) => cmd as string);
    expect(cmds.some((c) => c.includes("capture-pane"))).toBe(true);
    expect(cmds.some((c) => c.includes("/usage"))).toBe(true);
  });
});
