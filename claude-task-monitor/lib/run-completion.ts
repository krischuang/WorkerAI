/**
 * SSH helpers for reading durable completion files written by the wrapper script.
 *
 * The poller calls these on every cycle to check whether a task's done-file
 * exists on the remote server before falling back to tmux pane scanning.
 */

import { execSSH } from "@/lib/ssh";
import type { SSHConfig } from "@/lib/ssh-claude-tmux";
import { doneFilePath, logFilePath } from "@/lib/wrapper-script";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RunCompletion {
  taskId: string;
  agentId: string;
  runId: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  logPath: string;
}

export interface ReadRunResult {
  found: boolean;
  data?: RunCompletion;
  error?: string;
}

// ── Done-file reader ──────────────────────────────────────────────────────────

/**
 * Tries to read the done-file for a run from the remote server.
 *
 * Returns `found: false` when:
 *  - The file does not yet exist (task still running — normal case).
 *  - The file exists but contains invalid JSON (shouldn't happen; treated as not found).
 *  - The SSH call itself fails (network issue; poller will retry next cycle).
 *
 * The `cat … 2>/dev/null` suppresses "no such file" stderr so a missing file
 * produces an empty stdout with exit code 0, which we treat as found:false.
 */
export async function readRunCompletion(
  ssh: SSHConfig,
  runId: string,
): Promise<ReadRunResult> {
  const path = doneFilePath(runId);
  try {
    const { stdout } = await execSSH(ssh, `cat "${path}" 2>/dev/null`, 8_000);
    const trimmed = stdout.trim();
    if (!trimmed) return { found: false };
    const data = JSON.parse(trimmed) as RunCompletion;
    return { found: true, data };
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Log tail reader ───────────────────────────────────────────────────────────

/**
 * Reads the last `lines` lines of the wrapper log file from the remote server.
 * Returns an empty string on any error (non-fatal — the log is supplementary).
 */
export async function readLogTail(
  ssh: SSHConfig,
  runId: string,
  lines = 200,
): Promise<string> {
  const path = logFilePath(runId);
  try {
    const { stdout } = await execSSH(
      ssh,
      `tail -n ${lines} "${path}" 2>/dev/null`,
      8_000,
    );
    return stdout;
  } catch {
    return "";
  }
}

// ── tmux session presence check ───────────────────────────────────────────────

/**
 * Returns true if the named tmux session exists on the remote server.
 * Used to distinguish "still running" from "session gone + no done-file".
 */
export async function tmuxSessionExists(
  ssh: SSHConfig,
  sessionName: string,
): Promise<boolean> {
  try {
    const { stdout } = await execSSH(
      ssh,
      `tmux has-session -t ${sessionName} 2>/dev/null && echo yes || echo no`,
      5_000,
    );
    return stdout.trim() === "yes";
  } catch {
    return false;
  }
}
