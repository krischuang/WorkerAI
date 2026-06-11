/**
 * Fetches Claude CLI usage by sending /usage to an existing Claude REPL
 * running inside the "claude" tmux session on the remote server.
 *
 * Setup required once on the worker server:
 *   tmux new-session -d -s claude
 *   tmux send-keys -t claude 'claude' Enter
 *
 * The actual /usage output from Claude Code v2.x looks like:
 *
 *   Current session
 *   ██████████████ 100% used
 *   Resets 3:10pm (UTC)
 *
 *   Current week (all models)
 *   █████           10% used
 *   Resets Jun 15, 9am (UTC)
 *
 * Reset times are converted from UTC to Australia/Sydney timezone.
 */

import { execSSH } from "@/lib/ssh";
import {
  type ClaudeUsageParsed,
  parseUTCResetTime,
  toSydney,
  utcToSydney,
  extractSection,
  parseUsage,
  looksLikeUsage,
  cleanPane,
  stripAnsi,
  classifyIdlePane,
  classifyPreflightPane,
  detectCompletionBlock,
} from "@/lib/usage-parser";
import { buildDispatchPrompt, type DispatchTask } from "@/lib/prompt-sanitiser";
import { COMPLETION_SCAN_LINES } from "@/lib/constants";

export type { ClaudeUsageParsed };

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClaudePermissionMode = "read_only" | "workspace_write" | "full_autonomous";

export const PERMISSION_MODE_LABEL: Record<ClaudePermissionMode, string> = {
  read_only:        "Read Only",
  workspace_write:  "Workspace Write",
  full_autonomous:  "Full Autonomous",
};

export const PERMISSION_MODE_DESCRIPTION: Record<ClaudePermissionMode, string> = {
  read_only:        "Claude can read and analyze files only — no writes or shell execution.",
  workspace_write:  "Claude can edit files and run commands; prompts before risky operations.",
  full_autonomous:  "Claude skips all permission prompts — runs fully unattended (--dangerously-skip-permissions).",
};

export function getClaudeLaunchCommand(mode: ClaudePermissionMode): string {
  switch (mode) {
    case "read_only":
      return `claude --allowedTools "Read,Grep,Glob,LS,WebSearch,WebFetch"`;
    case "workspace_write":
      return "claude";
    case "full_autonomous":
      return "claude --dangerously-skip-permissions";
  }
}

export type ClaudeUsageStatus =
  | "ok"
  | "auth_required"
  | "rate_limited"
  | "offline"
  | "error";


export interface ClaudeUsageResult {
  success: boolean;
  status: ClaudeUsageStatus;
  rawOutput: string;
  parsed: ClaudeUsageParsed;
  error?: string;
}

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  sshKeyPath: string;
}

// ─── tmux capture helpers — see lib/usage-parser.ts for pure implementations ──

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchClaudeUsageViaTmux(
  config: SSHConfig,
  tmuxSession: string,
): Promise<ClaudeUsageResult> {
  if (!tmuxSession || !tmuxSession.trim()) {
    return {
      success: false, status: "offline", rawOutput: "", parsed: {},
      error: "Agent tmuxSession is not configured. Set the tmuxSession field on the agent.",
    };
  }
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };

  // ── 1. Verify tmux session exists ─────────────────────────────────────────
  let sessionExists: boolean;
  try {
    const { stdout } = await execSSH(
      ssh,
      `tmux has-session -t ${tmuxSession} 2>/dev/null && echo yes || echo no`,
      5_000
    );
    sessionExists = stdout.trim() === "yes";
  } catch (err) {
    return {
      success: false, status: "offline", rawOutput: "", parsed: {},
      error: `SSH error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!sessionExists) {
    return {
      success: false, status: "offline", rawOutput: "", parsed: {},
      error:
        `tmux session '${tmuxSession}' not found. ` +
        `Create it:\n  tmux new-session -d -s ${tmuxSession}\n  tmux send-keys -t ${tmuxSession} 'claude' Enter`,
    };
  }

  // ── 2. Pre-flight: check current pane state (tail-window only) ───────────
  // We inspect only the last PREFLIGHT_TAIL_LINES non-empty lines so that
  // stale error messages from earlier in the session cannot trigger false
  // positives.  Full-pane scanning was the bug — do not revert to it.
  //
  // auth_required is retried up to 2× with a short delay before declaring
  // failure, because the pane may transiently show login-related text during
  // session startup, token refresh, or after a server reboot.
  const AUTH_PREFLIGHT_RETRY_DELAYS_MS = [2_000, 2_000];

  let before = "";
  let preflight = classifyPreflightPane(before); // sentinel; overwritten below

  for (let attempt = 0; attempt <= AUTH_PREFLIGHT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${tmuxSession} -p`, 5_000);
      before = cleanPane(stdout);
    } catch { /* non-fatal */ }

    preflight = classifyPreflightPane(before);

    if (preflight.status !== "auth_required" || attempt === AUTH_PREFLIGHT_RETRY_DELAYS_MS.length) break;

    const delay = AUTH_PREFLIGHT_RETRY_DELAYS_MS[attempt];
    console.log(`[preflight] auth_required on attempt ${attempt + 1} — retrying in ${delay}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  const preflightTs = preflight.detectedAt.toISOString();

  if (preflight.status === "auth_required") {
    console.log(`[preflight ${preflightTs}] auth failure confirmed after retries`);
    return {
      success: false, status: "auth_required",
      rawOutput: before.slice(-500), parsed: {},
      error: "Claude CLI is not authenticated. SSH in and run 'claude login'.",
    };
  }
  if (preflight.status === "rate_limited") {
    console.log(`[preflight ${preflightTs}] rate limit detected`);
    return {
      success: false, status: "rate_limited",
      rawOutput: before.slice(-500), parsed: {},
      error: "Claude CLI is rate limited. Wait a moment before refreshing.",
    };
  }
  if (preflight.status === "session_unavailable") {
    console.log(`[preflight ${preflightTs}] session unavailable detected`);
    return {
      success: false, status: "offline",
      rawOutput: before.slice(-500), parsed: {},
      error: "Claude CLI session is unavailable.",
    };
  }

  // ── 3. Send /usage and wait for the panel to render ───────────────────────
  try {
    await execSSH(ssh, `tmux send-keys -t ${tmuxSession} "/usage" Enter && sleep 3`, 12_000);
  } catch (err) {
    return {
      success: false, status: "error", rawOutput: "", parsed: {},
      error: `Failed to send /usage: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 4. Capture the rendered pane (retry up to 3× if overlay not visible) ─
  // The /usage panel can take a moment to render, especially when Claude is
  // actively processing. Retry with extra sleeps before giving up.
  let captured = "";
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${tmuxSession} -p`, 5_000);
      captured = cleanPane(stdout);
      if (looksLikeUsage(captured)) break;
      if (attempt < 2) {
        await execSSH(ssh, `sleep 2`, 5_000).catch(() => {});
      }
    }
  } catch (err) {
    return {
      success: false, status: "error", rawOutput: "", parsed: {},
      error: `Failed to capture pane: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 5. Dismiss dialog — await so the pane is clear before returning ────────
  try {
    await execSSH(
      ssh,
      `tmux send-keys -t ${tmuxSession} Escape 2>/dev/null; sleep 0.8`,
      5_000
    );
  } catch { /* non-fatal */ }

  // ── 6. Parse ─────────────────────────────────────────────────────────────
  const hasData = looksLikeUsage(captured);
  const parsed = hasData ? parseUsage(captured) : {};

  return {
    success: hasData,
    status: hasData ? "ok" : "error",
    rawOutput: captured.slice(-500),
    parsed,
    error: hasData
      ? undefined
      : `Could not extract usage data. Is Claude CLI running in the '${tmuxSession}' tmux session?`,
  };
}

// ─── pipe-pane stream capture for /usage ─────────────────────────────────────

/**
 * Extended result that includes the ANSI-stripped cleaned output captured via
 * pipe-pane.  rawOutput contains the unmodified stream bytes (truncated to
 * 2000 chars); cleanedOutput is the result of stripAnsi + cleanPane.
 */
export interface PipePaneUsageResult extends ClaudeUsageResult {
  cleanedOutput: string;
}

/**
 * Fetch Claude CLI /usage data via tmux pipe-pane stream capture.
 *
 * Unlike fetchClaudeUsageViaTmux (which uses capture-pane), this function
 * enables pipe-pane for a short window to stream raw terminal output to a
 * temporary file, then immediately disables it and deletes the file.
 *
 * Why pipe-pane: Claude Code renders /usage through a TUI that uses the
 * alternate screen buffer and cursor-positioning escape codes.  capture-pane
 * captures the rendered screen contents which may not include the overlay when
 * Claude is using the alternate buffer.  pipe-pane captures the raw byte
 * stream so the text is always present, just interspersed with ANSI codes that
 * we strip afterward.
 *
 * No persistent log file is created — the temp file is deleted immediately
 * after reading, and pipe-pane is left disabled after each call.
 */
export async function fetchClaudeUsageViaPipePaneTmux(
  config: SSHConfig,
  tmuxSession: string,
): Promise<PipePaneUsageResult> {
  if (!tmuxSession || !tmuxSession.trim()) {
    return {
      success: false, status: "offline", rawOutput: "", cleanedOutput: "", parsed: {},
      error: "Agent tmuxSession is not configured. Set the tmuxSession field on the agent.",
    };
  }

  const ssh = {
    host: config.host, port: config.port,
    username: config.username, sshKeyPath: config.sshKeyPath,
  };

  // ── 1. Verify session exists ───────────────────────────────────────────────
  let sessionExists: boolean;
  try {
    const { stdout } = await execSSH(
      ssh, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo yes || echo no`, 5_000
    );
    sessionExists = stdout.trim() === "yes";
  } catch (err) {
    return {
      success: false, status: "offline", rawOutput: "", cleanedOutput: "", parsed: {},
      error: `SSH error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!sessionExists) {
    return {
      success: false, status: "offline", rawOutput: "", cleanedOutput: "", parsed: {},
      error:
        `tmux session '${tmuxSession}' not found. ` +
        `Create it:\n  tmux new-session -d -s ${tmuxSession}\n  tmux send-keys -t ${tmuxSession} 'claude' Enter`,
    };
  }

  // ── 2. Pre-flight: check pane for auth/rate-limit/session errors ───────────
  let beforeText = "";
  const AUTH_PREFLIGHT_RETRY_DELAYS_MS = [2_000, 2_000];
  let preflight = classifyPreflightPane(beforeText);

  for (let attempt = 0; attempt <= AUTH_PREFLIGHT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${tmuxSession} -p`, 5_000);
      beforeText = cleanPane(stdout);
    } catch { /* non-fatal */ }

    preflight = classifyPreflightPane(beforeText);
    if (preflight.status !== "auth_required" || attempt === AUTH_PREFLIGHT_RETRY_DELAYS_MS.length) break;
    await new Promise<void>((resolve) => setTimeout(resolve, AUTH_PREFLIGHT_RETRY_DELAYS_MS[attempt]));
  }

  if (preflight.status === "auth_required") {
    return {
      success: false, status: "auth_required",
      rawOutput: beforeText.slice(-500), cleanedOutput: "", parsed: {},
      error: "Claude CLI is not authenticated. SSH in and run 'claude login'.",
    };
  }
  if (preflight.status === "rate_limited") {
    return {
      success: false, status: "rate_limited",
      rawOutput: beforeText.slice(-500), cleanedOutput: "", parsed: {},
      error: "Claude CLI is rate limited. Wait a moment before refreshing.",
    };
  }
  if (preflight.status === "session_unavailable") {
    return {
      success: false, status: "offline",
      rawOutput: beforeText.slice(-500), cleanedOutput: "", parsed: {},
      error: "Claude CLI session is unavailable.",
    };
  }

  // ── 3. Create unique temp file path ───────────────────────────────────────
  const tmpFile = `/tmp/.claude_usage_pipe_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  let rawOutput = "";
  let captureErr: string | undefined;

  try {
    // ── 4. Enable pipe-pane, send /usage, wait for TUI to render ────────────
    // pipe-pane -o pipes only pane output (not keystrokes) to the shell command.
    // The "cat > file" subprocess receives the raw byte stream while active.
    await execSSH(
      ssh,
      `tmux pipe-pane -o -t ${tmuxSession} "cat > ${tmpFile}" && ` +
      `tmux send-keys -t ${tmuxSession} "/usage" Enter && sleep 4`,
      14_000,
    );

    // ── 5. Disable pipe-pane (no command arg = disable) ────────────────────
    await execSSH(ssh, `tmux pipe-pane -t ${tmuxSession}`, 5_000).catch(() => {});

    // ── 6. Read the captured output ─────────────────────────────────────────
    const { stdout } = await execSSH(ssh, `cat ${tmpFile} 2>/dev/null || echo ""`, 5_000);
    rawOutput = stdout;

    // ── 7. Delete temp file immediately ────────────────────────────────────
    await execSSH(ssh, `rm -f ${tmpFile}`, 5_000).catch(() => {});
  } catch (err) {
    captureErr = err instanceof Error ? err.message : String(err);
    // Best-effort cleanup — do not re-throw
    await execSSH(ssh, `tmux pipe-pane -t ${tmuxSession} 2>/dev/null; rm -f ${tmpFile}`, 5_000).catch(() => {});
  }

  // ── 8. Dismiss /usage dialog so the pane accepts the next command ─────────
  await execSSH(
    ssh, `tmux send-keys -t ${tmuxSession} Escape 2>/dev/null; sleep 0.5`, 4_000,
  ).catch(() => {});

  if (captureErr) {
    return {
      success: false, status: "error", rawOutput: "", cleanedOutput: "", parsed: {},
      error: `Capture failed: ${captureErr}`,
    };
  }

  // ── 9. Strip ANSI codes and normalize line endings ────────────────────────
  const cleanedOutput = cleanPane(stripAnsi(rawOutput));

  // ── 10. Parse ─────────────────────────────────────────────────────────────
  const hasData = looksLikeUsage(cleanedOutput);
  const parsed = hasData ? parseUsage(cleanedOutput) : {};

  return {
    success: hasData,
    status: hasData ? "ok" : "error",
    rawOutput: rawOutput.slice(-2000),
    cleanedOutput: cleanedOutput.slice(-2000),
    parsed,
    error: hasData
      ? undefined
      : `Could not extract usage data from pipe-pane output. Is Claude running in '${tmuxSession}'?`,
  };
}

// ─── Launch / restart Claude in tmux ─────────────────────────────────────────

export interface LaunchClaudeResult {
  success: boolean;
  command: string;
  error?: string;
}

/**
 * Kills any running process in the tmux session and relaunches Claude CLI with
 * the flags that correspond to the configured permission mode.
 */
export async function launchClaudeInTmux(
  config: SSHConfig,
  mode: ClaudePermissionMode,
  tmuxSession: string,
  workDir?: string,
): Promise<LaunchClaudeResult> {
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };
  const baseCommand = getClaudeLaunchCommand(mode);
  const claudeCommand = workDir ? `HOME=${workDir} ${baseCommand}` : baseCommand;

  // Verify the tmux session exists
  try {
    const { stdout } = await execSSH(
      ssh,
      `tmux has-session -t ${tmuxSession} 2>/dev/null && echo yes || echo no`,
      5_000
    );
    if (stdout.trim() !== "yes") {
      // Session doesn't exist — create it and launch Claude
      const createCmd = [
        `tmux new-session -d -s ${tmuxSession}`,
        `tmux send-keys -t ${tmuxSession} '${claudeCommand}' Enter`,
      ].join(" && ");
      await execSSH(ssh, createCmd, 10_000);
      return { success: true, command: claudeCommand };
    }
  } catch (err) {
    return {
      success: false,
      command: claudeCommand,
      error: `SSH error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Session exists — interrupt any running process, then relaunch
  try {
    const relaunchCmd = [
      `tmux send-keys -t ${tmuxSession} C-c`,
      `sleep 0.6`,
      `tmux send-keys -t ${tmuxSession} '${claudeCommand}' Enter`,
    ].join(" && ");
    await execSSH(ssh, relaunchCmd, 15_000);
    return { success: true, command: claudeCommand };
  } catch (err) {
    return {
      success: false,
      command: claudeCommand,
      error: `Failed to relaunch Claude: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Per-task tmux session management ────────────────────────────────────────

/**
 * Returns the deterministic tmux session name for a given task.
 * Format: claude_<taskId>
 *
 * Using the taskId keeps names unique, human-readable in `tmux ls`, and
 * makes it easy to correlate a session to its task in the database.
 */
export function taskTmuxSessionName(taskId: string): string {
  return `claude_${taskId}`;
}

export interface CreateTaskSessionResult {
  success: boolean;
  sessionName: string;
  error?: string;
}

/**
 * Creates a new, isolated tmux session for a single task and launches Claude
 * inside it.  The session is named claude_<taskId> so multiple tasks can run
 * in parallel on the same server without sharing a session.
 *
 * Waits 2 s after launching Claude so the REPL is ready to receive input by
 * the time the caller calls sendTaskToTmux.
 */
export async function createAndLaunchTaskSession(
  config: SSHConfig,
  taskId: string,
  mode: ClaudePermissionMode,
  workDir?: string,
): Promise<CreateTaskSessionResult> {
  const sessionName = taskTmuxSessionName(taskId);
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };

  const baseCommand = getClaudeLaunchCommand(mode);
  const claudeCommand = workDir ? `HOME=${workDir} ${baseCommand}` : baseCommand;

  try {
    const cmd = [
      `tmux new-session -d -s ${sessionName}`,
      `tmux send-keys -t ${sessionName} '${claudeCommand}' Enter`,
      `sleep 2`,
    ].join(" && ");
    await execSSH(ssh, cmd, 20_000);
    return { success: true, sessionName };
  } catch (err) {
    return {
      success: false,
      sessionName,
      error: `Failed to create task session: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Kills the per-task tmux session created by createAndLaunchTaskSession.
 * Non-fatal — silently swallows errors so callers can fire-and-forget on
 * task completion or failure without worrying about cleanup failures.
 */
export async function killTaskTmuxSession(
  config: SSHConfig,
  taskId: string,
): Promise<void> {
  const sessionName = taskTmuxSessionName(taskId);
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };
  try {
    await execSSH(
      ssh,
      `tmux kill-session -t ${sessionName} 2>/dev/null || true`,
      5_000,
    );
  } catch { /* non-fatal */ }
}

// ─── Detect if Claude is idle (waiting for input) ────────────────────────────

export interface ClaudeIdleResult {
  isIdle: boolean;
  paneText: string;
  error?: string;
  /** true when the tmux session itself does not exist */
  tmuxMissing?: boolean;
}

/**
 * Checks whether the Claude tmux session is idle (waiting for user input).
 *
 * Claude Code renders a status bar below the input prompt, so the very last
 * non-empty line of the captured pane is the status bar, not ">". We scan
 * the last several non-empty lines so the check is robust to that footer.
 *
 * We also confirm Claude is not actively working by checking that none of
 * the recent lines contain a spinner or "Thinking" indicator.
 */
export async function detectClaudeIdle(
  config: SSHConfig,
  tmuxSession: string,
): Promise<ClaudeIdleResult> {
  if (!tmuxSession || !tmuxSession.trim()) {
    return {
      isIdle: false,
      paneText: "",
      tmuxMissing: true,
      error: "tmuxSession is not configured",
    };
  }
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };

  try {
    const { stdout, stderr, exitCode } = await execSSH(
      ssh,
      `tmux capture-pane -t ${tmuxSession} -p`,
      5_000
    );

    // tmux exits non-zero and prints "can't find session" when the session
    // does not exist.  Surface this so callers can distinguish "not idle"
    // from "session missing".
    if (exitCode !== 0) {
      const isMissing = /can.?t find session|no server running/i.test(
        stderr + stdout
      );
      return {
        isIdle: false,
        paneText: "",
        tmuxMissing: isMissing,
        error: isMissing
          ? `tmux session '${tmuxSession}' not found`
          : `tmux capture-pane failed (exit ${exitCode}): ${stderr}`,
      };
    }

    const pane = cleanPane(stdout);
    const { isIdle, hasPrompt, isBusy } = classifyIdlePane(pane);

    if (!isIdle) {
      const tail = pane.split("\n").filter((l) => l.trim().length > 0).slice(-6);
      console.log(
        `[idle-detect] NOT idle — hasPrompt=${hasPrompt} isBusy=${isBusy}\n` +
        `  tail lines:\n` +
        tail.map((l, i) => `    [${i}] ${JSON.stringify(l)}`).join("\n")
      );
    }

    return { isIdle, paneText: pane.slice(-2000) };
  } catch (err) {
    return {
      isIdle: false,
      paneText: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Detect task completion (marker + idle fallback) ─────────────────────────

export interface TaskCompletionResult {
  /** true when a valid structured completion block was found in post-dispatch output */
  markerFound: boolean;
  /** true when the pane shows the idle Claude prompt (fallback for tasks without nonce) */
  isIdle: boolean;
  /** true when either markerFound or isIdle — caller should mark the task done */
  completed: boolean;
  paneText: string;
  error?: string;
  tmuxMissing?: boolean;
}

/**
 * Checks whether a running task has finished.
 *
 * Primary signal: a structured [WORKERAI_RESULT] block appearing AFTER the
 * dispatch point (outputOffset), with matching taskId, status=completed, and nonce.
 * The offset ensures we never match the block template that was sent as part
 * of the prompt instructions.
 *
 * Fallback: idle-pane detection — used only when no nonce is provided (tasks
 * dispatched before the nonce protocol was introduced).
 *
 * When the marker is detected, sends Escape to dismiss any blocking prompts
 * (feedback dialogs, /usage overlays) so the session is ready for the next task.
 */
export async function detectTaskCompletion(
  config: SSHConfig,
  tmuxSession: string,
  taskId?: string,
  expectedNonce?: string,
  outputOffset?: number,
): Promise<TaskCompletionResult> {
  if (!tmuxSession || !tmuxSession.trim()) {
    return {
      markerFound: false, isIdle: false, completed: false,
      paneText: "",
      tmuxMissing: true,
      error: "tmuxSession is not configured",
    };
  }

  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };

  // Capture enough scrollback to cover from outputOffset onward.
  const captureDepth = (outputOffset !== undefined && outputOffset > 0)
    ? Math.min(outputOffset + 200, 5000)
    : COMPLETION_SCAN_LINES;

  try {
    const { stdout, stderr, exitCode } = await execSSH(
      ssh,
      `tmux capture-pane -t ${tmuxSession} -p -S -${captureDepth}`,
      8_000,
    );

    if (exitCode !== 0) {
      const isMissing = /can.?t find session|no server running/i.test(stderr + stdout);
      return {
        markerFound: false, isIdle: false, completed: false,
        paneText: "",
        tmuxMissing: isMissing,
        error: isMissing
          ? `tmux session '${tmuxSession}' not found`
          : `tmux capture-pane failed (exit ${exitCode}): ${stderr}`,
      };
    }

    const pane = cleanPane(stdout);

    // Only scan lines produced after the dispatch point, so the completion
    // block template embedded in the prompt text is never matched.
    let scanText: string;
    if (outputOffset !== undefined && outputOffset > 0) {
      const lines = pane.split("\n");
      scanText = lines.length > outputOffset ? lines.slice(outputOffset).join("\n") : "";
    } else {
      scanText = pane;
    }

    const markerFound = (taskId && expectedNonce)
      ? detectCompletionBlock(scanText, taskId, expectedNonce)
      : false;

    const { isIdle } = classifyIdlePane(pane);
    // Idle fallback only applies to tasks dispatched without a nonce.
    const completed = markerFound || (!expectedNonce && isIdle);

    if (markerFound) {
      // Dismiss any open dialogs/overlays so the session can accept the next task.
      await execSSH(
        ssh,
        `tmux send-keys -t ${tmuxSession} Escape 2>/dev/null; sleep 0.5`,
        5_000,
      ).catch(() => {});
    }

    return { markerFound, isIdle, completed, paneText: pane.slice(-2000) };
  } catch (err) {
    return {
      markerFound: false, isIdle: false, completed: false,
      paneText: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Send task to Claude in tmux ─────────────────────────────────────────────

/**
 * Sends a task prompt to the Claude REPL running in the "claude" tmux session.
 * Uses base64 + tmux load-buffer to safely handle any text content.
 */
/**
 * Send a pre-built prompt string to the Claude tmux session.
 * Handles the base64 encoding, temp-file, and paste mechanics.
 * Does NOT build or sanitise the prompt — callers are responsible for that.
 */
export async function sendRawPromptToTmux(
  config: SSHConfig,
  promptText: string,
  tmuxSession: string,
): Promise<{ success: boolean; error?: string }> {
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };

  try {
    const { stdout } = await execSSH(
      ssh,
      `tmux has-session -t ${tmuxSession} 2>/dev/null && echo yes || echo no`,
      5_000
    );
    if (stdout.trim() !== "yes") {
      return { success: false, error: `tmux session '${tmuxSession}' not found.` };
    }
  } catch (err) {
    return {
      success: false,
      error: `SSH error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Base64-encode so any characters in the prompt survive shell quoting.
  const b64 = Buffer.from(promptText).toString("base64");

  // Use a unique temp file per invocation to avoid collisions when multiple
  // dispatches run concurrently (e.g. poller + manual run at the same time).
  const tmpFile = `/tmp/.claude_task_${crypto.randomUUID()}`;

  const cmd = [
    `printf '%s' '${b64}' | base64 -d > ${tmpFile}`,
    `tmux load-buffer ${tmpFile}`,
    `tmux paste-buffer -t ${tmuxSession}`,
    `sleep 0.3`,
    `tmux send-keys -t ${tmuxSession} Enter`,
    `rm -f ${tmpFile}`,
  ].join(" && ");

  try {
    await execSSH(ssh, cmd, 10_000);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Failed to send task to tmux: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build a structurally hardened prompt from the task fields and paste it into
 * the Claude tmux session.  User-supplied fields are XML-fenced to prevent
 * prompt-injection attacks.
 *
 * Captures the current scrollback line count BEFORE sending so the caller can
 * store an output offset and later skip pre-dispatch pane content when scanning
 * for the completion block.  Returns outputOffset = pre-dispatch lines +
 * prompt lines + safety buffer.
 */
export async function sendTaskToTmux(
  config: SSHConfig,
  task: DispatchTask,
  tmuxSession: string,
): Promise<{ success: boolean; outputOffset?: number; error?: string }> {
  const promptText = buildDispatchPrompt(task);
  const promptLineCount = promptText.split("\n").length;

  // Capture pre-dispatch line count so we can skip old content when checking completion.
  let outputOffset: number | undefined;
  try {
    const ssh = {
      host: config.host,
      port: config.port,
      username: config.username,
      sshKeyPath: config.sshKeyPath,
    };
    const { stdout } = await execSSH(
      ssh,
      `tmux capture-pane -t ${tmuxSession} -p -S -${COMPLETION_SCAN_LINES} 2>/dev/null | wc -l`,
      5_000,
    );
    const preLines = parseInt(stdout.trim(), 10);
    if (!isNaN(preLines)) {
      // +40 safety buffer covers terminal line-wrapping of the prompt text.
      outputOffset = preLines + promptLineCount + 40;
    }
  } catch { /* non-fatal — proceed without offset */ }

  const result = await sendRawPromptToTmux(config, promptText, tmuxSession);
  return { ...result, outputOffset };
}
