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

export interface ClaudeUsageParsed {
  sessionPct?: number;       // 0–100
  sessionResets?: string;    // reset time in Sydney timezone (display string)
  sessionResetsAt?: Date;    // UTC Date for DB storage & countdown math
  weekPct?: number;          // 0–100
  weekResets?: string;       // reset time in Sydney timezone (display string)
  weekResetsAt?: Date;       // UTC Date for DB storage & countdown math
}

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

// ─── Timezone helpers ─────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a UTC time string from Claude's /usage output and return a Date.
 *
 * Formats:
 *   "3:10pm"         — time only (today or tomorrow in UTC)
 *   "9am"            — time only, no minutes
 *   "Jun 15, 9am"    — date + time (current or next year)
 *   "Jun 15, 3:10pm" — date + time with minutes
 */
function parseUTCResetTime(str: string): Date | null {
  const s = str.trim();
  const now = new Date();

  // "H:Mam/pm" or "Ham/pm" — time only
  const timeOnly = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (timeOnly) {
    let h = parseInt(timeOnly[1]);
    const m = timeOnly[2] ? parseInt(timeOnly[2]) : 0;
    const ap = timeOnly[3].toLowerCase();
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;

    const candidate = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m
    ));
    // If that time has already passed today, it's tomorrow
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate;
  }

  // "Mon DD, H:Mam/pm" or "Mon DD, Ham/pm"
  const dateTime = s.match(/^(\w+)\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (dateTime) {
    const month = MONTHS[dateTime[1].toLowerCase()];
    if (month === undefined) return null;
    const day = parseInt(dateTime[2]);
    let h = parseInt(dateTime[3]);
    const m = dateTime[4] ? parseInt(dateTime[4]) : 0;
    const ap = dateTime[5].toLowerCase();
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;

    let year = now.getUTCFullYear();
    let date = new Date(Date.UTC(year, month, day, h, m));
    if (date < now) date = new Date(Date.UTC(year + 1, month, day, h, m));
    return date;
  }

  return null;
}

/**
 * Format a Date as a Sydney-timezone human-readable string.
 * e.g. "Jun 10, 1:10 am (Sydney)"
 */
function toSydney(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${fmt} (Sydney)`;
}

function utcToSydney(utcStr: string): string {
  const date = parseUTCResetTime(utcStr);
  return date ? toSydney(date) : utcStr;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extract the usage percent and reset time from a section of the /usage output.
 *
 * Looks for a pattern like:
 *   [section title line]
 *   [progress bar with X% used]
 *   Resets [time] (UTC)
 */
function extractSection(
  text: string,
  sectionPattern: RegExp
): { pct: number; resetsRaw: string } | null {
  // Find the section heading
  const headingMatch = sectionPattern.exec(text);
  if (!headingMatch) return null;

  // Grab the next ~200 chars after the heading to look for % and Resets
  const slice = text.slice(headingMatch.index, headingMatch.index + 300);

  const pctMatch = slice.match(/(\d+)%\s*used/);
  const resetMatch = slice.match(/Resets\s+(.+?)\s*\(UTC\)/);

  if (!pctMatch && !resetMatch) return null;

  return {
    pct: pctMatch ? parseInt(pctMatch[1]) : 0,
    resetsRaw: resetMatch ? resetMatch[1].trim() : "",
  };
}

function parseUsage(text: string): ClaudeUsageParsed {
  const session = extractSection(text, /Current session/i);
  const week = extractSection(text, /Current week/i);

  return {
    sessionPct:      session?.pct,
    sessionResets:   session?.resetsRaw ? utcToSydney(session.resetsRaw) : undefined,
    sessionResetsAt: session?.resetsRaw ? parseUTCResetTime(session.resetsRaw) ?? undefined : undefined,
    weekPct:         week?.pct,
    weekResets:      week?.resetsRaw ? utcToSydney(week.resetsRaw) : undefined,
    weekResetsAt:    week?.resetsRaw ? parseUTCResetTime(week.resetsRaw) ?? undefined : undefined,
  };
}

function looksLikeUsage(text: string): boolean {
  return /Current session/i.test(text) || /Current week/i.test(text) || /%\s*used/i.test(text);
}

// ─── tmux capture helpers ─────────────────────────────────────────────────────

function cleanPane(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "") // strip trailing whitespace tmux adds for padding
    .trim();
}

// ─── Main export ──────────────────────────────────────────────────────────────

const TMUX_SESSION = "claude";

export async function fetchClaudeUsageViaTmux(config: SSHConfig): Promise<ClaudeUsageResult> {
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
      `tmux has-session -t ${TMUX_SESSION} 2>/dev/null && echo yes || echo no`,
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
        `tmux session '${TMUX_SESSION}' not found. ` +
        `Create it:\n  tmux new-session -d -s ${TMUX_SESSION}\n  tmux send-keys -t ${TMUX_SESSION} 'claude' Enter`,
    };
  }

  // ── 2. Pre-flight: check current pane state ───────────────────────────────
  let before = "";
  try {
    const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${TMUX_SESSION} -p`, 5_000);
    before = cleanPane(stdout);
  } catch { /* non-fatal */ }

  if (/not\s+logged\s+in|please\s+log\s*in|run\s+claude\s+login/i.test(before)) {
    return {
      success: false, status: "auth_required",
      rawOutput: before.slice(-1000), parsed: {},
      error: "Claude CLI is not authenticated. SSH in and run 'claude login'.",
    };
  }
  if (/rate[\s-]limit|too\s+many\s+request/i.test(before)) {
    return {
      success: false, status: "rate_limited",
      rawOutput: before.slice(-1000), parsed: {},
      error: "Claude CLI is rate limited. Wait a moment before refreshing.",
    };
  }

  // ── 3. Send /usage and wait for the panel to render ───────────────────────
  try {
    await execSSH(ssh, `tmux send-keys -t ${TMUX_SESSION} "/usage" Enter && sleep 3`, 12_000);
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
      const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${TMUX_SESSION} -p`, 5_000);
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
      `tmux send-keys -t ${TMUX_SESSION} Escape 2>/dev/null; sleep 0.8`,
      5_000
    );
  } catch { /* non-fatal */ }

  // ── 6. Parse ─────────────────────────────────────────────────────────────
  const hasData = looksLikeUsage(captured);
  const parsed = hasData ? parseUsage(captured) : {};

  return {
    success: hasData,
    status: hasData ? "ok" : "error",
    rawOutput: captured.slice(-2000),
    parsed,
    error: hasData
      ? undefined
      : "Could not extract usage data. Is Claude CLI running in the 'claude' tmux session?",
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
  mode: ClaudePermissionMode
): Promise<LaunchClaudeResult> {
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };
  const claudeCommand = getClaudeLaunchCommand(mode);

  // Verify the tmux session exists
  try {
    const { stdout } = await execSSH(
      ssh,
      `tmux has-session -t ${TMUX_SESSION} 2>/dev/null && echo yes || echo no`,
      5_000
    );
    if (stdout.trim() !== "yes") {
      // Session doesn't exist — create it and launch Claude
      const createCmd = [
        `tmux new-session -d -s ${TMUX_SESSION}`,
        `tmux send-keys -t ${TMUX_SESSION} '${claudeCommand}' Enter`,
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
      `tmux send-keys -t ${TMUX_SESSION} C-c`,
      `sleep 0.6`,
      `tmux send-keys -t ${TMUX_SESSION} '${claudeCommand}' Enter`,
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

// ─── Detect if Claude is idle (waiting for input) ────────────────────────────

export interface ClaudeIdleResult {
  isIdle: boolean;
  paneText: string;
  error?: string;
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
export async function detectClaudeIdle(config: SSHConfig): Promise<ClaudeIdleResult> {
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };

  try {
    const { stdout } = await execSSH(
      ssh,
      `tmux capture-pane -t ${TMUX_SESSION} -p`,
      5_000
    );
    const pane = cleanPane(stdout);
    const lines = pane.split("\n").filter((l) => l.trim().length > 0);

    // Look for the "> " prompt in the last 6 lines — covers status bars / model
    // info footers that Claude Code renders below the input area.
    const tail = lines.slice(-6);
    const hasPrompt = tail.some((l) => /^[>❯]\s*$/.test(l));

    // Reject if Claude is visibly working (spinner chars, "Thinking", tool calls)
    const busyPattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Thinking\b|esc to interrupt/i;
    const isBusy = tail.some((l) => busyPattern.test(l));

    const isIdle = hasPrompt && !isBusy;

    if (!isIdle) {
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

// ─── Send task to Claude in tmux ─────────────────────────────────────────────

/**
 * Sends a task prompt to the Claude REPL running in the "claude" tmux session.
 * Uses base64 + tmux load-buffer to safely handle any text content.
 */
export async function sendTaskToTmux(
  config: SSHConfig,
  task: { title: string; description?: string | null; projectName?: string | null }
): Promise<{ success: boolean; error?: string }> {
  const ssh = {
    host: config.host,
    port: config.port,
    username: config.username,
    sshKeyPath: config.sshKeyPath,
  };

  // Verify session exists
  try {
    const { stdout } = await execSSH(
      ssh,
      `tmux has-session -t ${TMUX_SESSION} 2>/dev/null && echo yes || echo no`,
      5_000
    );
    if (stdout.trim() !== "yes") {
      return { success: false, error: `tmux session '${TMUX_SESSION}' not found.` };
    }
  } catch (err) {
    return {
      success: false,
      error: `SSH error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Format the prompt — project name (nav hint), task title, optional description
  const lines: string[] = [];
  if (task.projectName?.trim()) {
    lines.push(`Project: ${task.projectName.trim()}`);
  }
  lines.push(`Task: ${task.title}`);
  if (task.description?.trim()) {
    lines.push("", task.description.trim());
  }
  const prompt = lines.join("\n");

  // Base64 encode so any special characters in the task text are safe to pass through shell
  const b64 = Buffer.from(prompt).toString("base64");

  // Write to temp file → load into tmux buffer → paste → Enter
  const cmd = [
    `printf '%s' '${b64}' | base64 -d > /tmp/.claude_task`,
    `tmux load-buffer /tmp/.claude_task`,
    `tmux paste-buffer -t ${TMUX_SESSION}`,
    `sleep 0.3`,
    `tmux send-keys -t ${TMUX_SESSION} Enter`,
    `rm -f /tmp/.claude_task`,
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
