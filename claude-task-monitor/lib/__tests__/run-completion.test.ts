import { describe, it, expect, vi, beforeEach } from "vitest";
import { readRunCompletion, readLogTail, tmuxSessionExists } from "../run-completion";
import { doneFilePath, logFilePath } from "../wrapper-script";

// ── Mock SSH ──────────────────────────────────────────────────────────────────

vi.mock("../ssh", () => ({ execSSH: vi.fn() }));
vi.mock("../ssh-claude-tmux", () => ({})); // SSHConfig type only — no runtime exports needed

import { execSSH } from "../ssh";
const mockExecSSH = vi.mocked(execSSH);

const SSH: Parameters<typeof readRunCompletion>[0] = {
  host: "10.0.0.1",
  port: 22,
  username: "ec2-user",
  sshKeyPath: "/home/ec2-user/.ssh/id_rsa",
};

const VALID_PAYLOAD = {
  taskId: "task-abc",
  agentId: "agent-xyz",
  runId: "run-123",
  exitCode: 0,
  startedAt: "2026-06-12T10:00:00Z",
  finishedAt: "2026-06-12T10:05:00Z",
  logPath: logFilePath("run-123"),
};

// ── readRunCompletion ─────────────────────────────────────────────────────────

describe("readRunCompletion", () => {
  beforeEach(() => { mockExecSSH.mockReset(); });

  it("returns found:true with parsed data when SSH returns valid JSON", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: JSON.stringify(VALID_PAYLOAD), stderr: "", exitCode: 0 });
    const result = await readRunCompletion(SSH, "run-123");
    expect(result.found).toBe(true);
    expect(result.data?.exitCode).toBe(0);
    expect(result.data?.taskId).toBe("task-abc");
  });

  it("returns found:false when stdout is empty (file does not exist)", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    const result = await readRunCompletion(SSH, "run-123");
    expect(result.found).toBe(false);
    expect(result.data).toBeUndefined();
  });

  it("returns found:false with error when SSH throws", async () => {
    mockExecSSH.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await readRunCompletion(SSH, "run-123");
    expect(result.found).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  it("returns found:false when stdout contains invalid JSON", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "not-json", stderr: "", exitCode: 0 });
    const result = await readRunCompletion(SSH, "run-123");
    expect(result.found).toBe(false);
  });

  it("detects non-zero exit code in done-file", async () => {
    const failed = { ...VALID_PAYLOAD, exitCode: 1 };
    mockExecSSH.mockResolvedValueOnce({ stdout: JSON.stringify(failed), stderr: "", exitCode: 0 });
    const result = await readRunCompletion(SSH, "run-123");
    expect(result.found).toBe(true);
    expect(result.data?.exitCode).toBe(1);
  });

  it("SSHes to cat <doneFilePath> with 2>/dev/null", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: JSON.stringify(VALID_PAYLOAD), stderr: "", exitCode: 0 });
    await readRunCompletion(SSH, "run-123");
    const cmd = mockExecSSH.mock.calls[0][1] as string;
    expect(cmd).toContain(doneFilePath("run-123"));
    expect(cmd).toContain("2>/dev/null");
  });
});

// ── readLogTail ───────────────────────────────────────────────────────────────

describe("readLogTail", () => {
  beforeEach(() => { mockExecSSH.mockReset(); });

  it("returns stdout content on success", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "line1\nline2\n", stderr: "", exitCode: 0 });
    const result = await readLogTail(SSH, "run-123", 50);
    expect(result).toBe("line1\nline2\n");
  });

  it("returns empty string when SSH throws", async () => {
    mockExecSSH.mockRejectedValueOnce(new Error("timeout"));
    const result = await readLogTail(SSH, "run-123");
    expect(result).toBe("");
  });

  it("SSHes to tail -n <lines> of the log file", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    await readLogTail(SSH, "run-123", 100);
    const cmd = mockExecSSH.mock.calls[0][1] as string;
    expect(cmd).toContain("tail -n 100");
    expect(cmd).toContain(logFilePath("run-123"));
  });
});

// ── tmuxSessionExists ─────────────────────────────────────────────────────────

describe("tmuxSessionExists", () => {
  beforeEach(() => { mockExecSSH.mockReset(); });

  it("returns true when SSH outputs 'yes'", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "yes\n", stderr: "", exitCode: 0 });
    expect(await tmuxSessionExists(SSH, "claude_task-abc")).toBe(true);
  });

  it("returns false when SSH outputs 'no'", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "no\n", stderr: "", exitCode: 0 });
    expect(await tmuxSessionExists(SSH, "claude_task-abc")).toBe(false);
  });

  it("returns false when SSH throws", async () => {
    mockExecSSH.mockRejectedValueOnce(new Error("SSH error"));
    expect(await tmuxSessionExists(SSH, "claude_task-abc")).toBe(false);
  });

  it("checks the given session name in the command", async () => {
    mockExecSSH.mockResolvedValueOnce({ stdout: "yes", stderr: "", exitCode: 0 });
    await tmuxSessionExists(SSH, "claude_my-task");
    const cmd = mockExecSSH.mock.calls[0][1] as string;
    expect(cmd).toContain("claude_my-task");
    expect(cmd).toContain("tmux has-session");
  });
});
