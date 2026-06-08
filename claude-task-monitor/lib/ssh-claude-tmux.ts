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
    await execSSH(ssh, `tmux send-keys -t ${TMUX_SESSION} "/usage" Enter && sleep 2`, 10_000);
  } catch (err) {
    return {
      success: false, status: "error", rawOutput: "", parsed: {},
      error: `Failed to send /usage: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 4. Capture the rendered pane ─────────────────────────────────────────
  let captured = "";
  try {
    const { stdout } = await execSSH(ssh, `tmux capture-pane -t ${TMUX_SESSION} -p`, 5_000);
    captured = cleanPane(stdout);
  } catch (err) {
    return {
      success: false, status: "error", rawOutput: "", parsed: {},
      error: `Failed to capture pane: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 5. Dismiss dialog (Escape, fire-and-forget) ───────────────────────────
  execSSH(ssh, `sleep 0.5 && tmux send-keys -t ${TMUX_SESSION} Escape 2>/dev/null || true`, 3_000)
    .catch(() => { /* intentionally ignored */ });

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

// ─── Send task to Claude in tmux ─────────────────────────────────────────────

/**
 * Sends a task prompt to the Claude REPL running in the "claude" tmux session.
 * Uses base64 + tmux load-buffer to safely handle any text content.
 */
export async function sendTaskToTmux(
  config: SSHConfig,
  task: { title: string; description?: string | null }
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

  // Format the prompt — task title + optional description
  const lines = [`Task: ${task.title}`];
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
