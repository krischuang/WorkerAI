/**
 * Pure functions for parsing Claude CLI /usage output.
 * Extracted from ssh-claude-tmux.ts so they can be unit-tested without
 * requiring an SSH connection or a running tmux session.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeUsageParsed {
  sessionPct?: number;
  sessionResets?: string;    // reset time in Sydney timezone (display string)
  sessionResetsAt?: Date;    // UTC Date for DB storage & countdown math
  weekPct?: number;
  weekResets?: string;
  weekResetsAt?: Date;
}

// ─── Internal constants ───────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// ─── Time parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a UTC time string from Claude's /usage output and return a Date.
 *
 * Formats supported:
 *   "3:10pm"         — time only (today or tomorrow in UTC)
 *   "9am"            — time only, no minutes
 *   "Jun 15, 9am"    — date + time (current or next year)
 *   "Jun 15, 3:10pm" — date + time with minutes
 */
export function parseUTCResetTime(str: string): Date | null {
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

    const year = now.getUTCFullYear();
    let date = new Date(Date.UTC(year, month, day, h, m));
    if (date < now) date = new Date(Date.UTC(year + 1, month, day, h, m));
    return date;
  }

  return null;
}

// ─── Timezone display ─────────────────────────────────────────────────────────

/** Format a UTC Date as a Sydney-timezone human-readable string, e.g. "Jun 10, 1:10 am (Sydney)". */
export function toSydney(date: Date): string {
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

export function utcToSydney(utcStr: string): string {
  const date = parseUTCResetTime(utcStr);
  return date ? toSydney(date) : utcStr;
}

// ─── Output parser ────────────────────────────────────────────────────────────

/**
 * Extract the usage percent and reset time from one named section of
 * Claude's /usage output.
 */
export function extractSection(
  text: string,
  sectionPattern: RegExp
): { pct: number; resetsRaw: string } | null {
  const headingMatch = sectionPattern.exec(text);
  if (!headingMatch) return null;

  const slice = text.slice(headingMatch.index, headingMatch.index + 300);
  const pctMatch = slice.match(/(\d+)%\s*used/);
  const resetMatch = slice.match(/Resets\s+(.+?)\s*\(UTC\)/);

  if (!pctMatch && !resetMatch) return null;

  return {
    pct: pctMatch ? parseInt(pctMatch[1]) : 0,
    resetsRaw: resetMatch ? resetMatch[1].trim() : "",
  };
}

export function parseUsage(text: string): ClaudeUsageParsed {
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

export function looksLikeUsage(text: string): boolean {
  return /Current session/i.test(text) || /Current week/i.test(text) || /%\s*used/i.test(text);
}

// ─── tmux pane cleanup ────────────────────────────────────────────────────────

export function cleanPane(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// ─── Pre-flight pane classification ──────────────────────────────────────────

/**
 * How many non-empty lines from the bottom of the pane to inspect during
 * pre-flight.  Must stay in the 20–50 range.  Mirrors the tail-window
 * philosophy of classifyIdlePane — do NOT increase this to the full pane or
 * you reintroduce the stale-detection bug (historical errors triggering false
 * positives).
 *
 * DETECTION STRATEGY
 * ──────────────────
 * tmux capture-pane -p returns the entire visible terminal buffer.  Recent
 * output is anchored at the bottom; older output drifts toward the top.  By
 * slicing only the tail we treat the most-recent terminal activity as
 * "current" and ignore anything that has scrolled above the window.
 *
 * Do not revert to full-pane scanning.  If you are tempted to do so, read
 * the commit message for this change first.
 */
export const PREFLIGHT_TAIL_LINES = 30;

export type PreflightStatus =
  | "ok"
  | "rate_limited"
  | "auth_required"
  | "session_unavailable";

export interface PreflightClassification {
  status: PreflightStatus;
  /** Non-empty lines that were actually inspected — attach to logs. */
  tailLines: string[];
  /** Wall-clock instant the classification was made (for log timestamps). */
  detectedAt: Date;
}

/**
 * Classify a pre-flight pane snapshot using only the last PREFLIGHT_TAIL_LINES
 * non-empty lines.  Callers must pass a pane already processed by cleanPane().
 */
export function classifyPreflightPane(pane: string): PreflightClassification {
  const lines = pane.split("\n").filter((l) => l.trim().length > 0);
  const tailLines = lines.slice(-PREFLIGHT_TAIL_LINES);
  const tail = tailLines.join("\n");
  const detectedAt = new Date();

  if (/not\s+logged\s+in|please\s+log\s*in|run\s+claude\s+login/i.test(tail)) {
    return { status: "auth_required", tailLines, detectedAt };
  }
  if (/rate[\s-]limit|too\s+many\s+request/i.test(tail)) {
    return { status: "rate_limited", tailLines, detectedAt };
  }
  if (/session\s+unavailable|claude\s+is\s+not\s+(connected|available)/i.test(tail)) {
    return { status: "session_unavailable", tailLines, detectedAt };
  }

  return { status: "ok", tailLines, detectedAt };
}

// ─── Idle pane classification ─────────────────────────────────────────────────

export interface IdleClassification {
  isIdle: boolean;
  /** true when a bare `>` or `❯` prompt appears in the last 6 non-empty lines */
  hasPrompt: boolean;
  /** true when a spinner, "Thinking", or "esc to interrupt" appears in the tail */
  isBusy: boolean;
}

/**
 * Classify whether a tmux pane (already cleaned by cleanPane) represents an
 * idle Claude Code session waiting for input.
 *
 * Scans the last 6 non-empty lines so that the Claude Code status-bar footer
 * (rendered below the prompt) doesn't hide the idle signal.
 */
export function classifyIdlePane(pane: string): IdleClassification {
  const lines = pane.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-6);
  const hasPrompt = tail.some((l) => /^[>❯]\s*$/.test(l));
  const busyPattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\bThinking\b|esc to interrupt/i;
  const isBusy = tail.some((l) => busyPattern.test(l));
  return { isIdle: hasPrompt && !isBusy, hasPrompt, isBusy };
}
