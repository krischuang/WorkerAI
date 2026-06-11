/**
 * Pure functions for parsing Claude CLI /usage output and tmux pane state.
 * Extracted from ssh-claude-tmux.ts so they can be unit-tested without
 * requiring an SSH connection or a running tmux session.
 */

import { COMPLETION_BLOCK_START, COMPLETION_BLOCK_END } from "@/lib/constants";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeUsageParsed {
  sessionPct?: number;
  sessionResets?: string;    // reset time in Sydney timezone (display string)
  sessionResetsAt?: Date;    // UTC Date for DB storage & countdown math
  weekPct?: number;
  weekResets?: string;
  weekResetsAt?: Date;
  /** undefined = not found in output; false = "Usage credits are off"; true = "Usage credits are on" */
  usageCreditsEnabled?: boolean;
  /** Total input tokens for the current session (if present in /usage output) */
  sessionInputTokens?: number;
  /** Total output tokens for the current session (if present in /usage output) */
  sessionOutputTokens?: number;
  /** Model name extracted from usage output (e.g. "claude-sonnet-4-5") */
  modelName?: string;
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

  // "Mon DD, H:Mam/pm" or "Mon DD, Ham/pm" — \s* tolerates spaces stripped by pipe-pane
  // Use [A-Za-z]+ (not \w+) so the month name doesn't swallow the day digits
  const dateTime = s.match(/^([A-Za-z]+)\s*(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
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
): { pct: number | undefined; resetsRaw: string } | null {
  const headingMatch = sectionPattern.exec(text);
  if (!headingMatch) return null;

  const slice = text.slice(headingMatch.index, headingMatch.index + 300);
  const pctMatch = slice.match(/(\d+)%\s*used/);
  // \s* instead of \s+ — pipe-pane output strips spaces between words
  const resetMatch = slice.match(/Resets\s*(.+?)\s*\(UTC\)/);

  if (!pctMatch && !resetMatch) return null;

  return {
    // undefined (not 0) when the percentage isn't in the captured text so the
    // caller can distinguish "parse succeeded, truly 0%" from "parse failed"
    pct: pctMatch ? parseInt(pctMatch[1]) : undefined,
    resetsRaw: resetMatch ? resetMatch[1].trim() : "",
  };
}

/**
 * Parse token counts from /usage output.
 * Handles formats like:
 *   "Input: 1,234,567 tokens"  "Output: 123,456 tokens"
 *   "1,234,567 input tokens"   "123,456 output tokens"
 *   "Tokens used: 1,234,567 / 2,000,000"
 */
export function parseTokenCounts(
  text: string
): { inputTokens: number | undefined; outputTokens: number | undefined; modelName: string | undefined } {
  const clean = (s: string) => parseInt(s.replace(/,/g, ""), 10);

  // "Input tokens: 1,234,567" or "Input: 1,234,567 tokens"
  const inputMatch =
    text.match(/input\s*(?:tokens)?[:\s]+([0-9][0-9,]*)\s*(?:tokens)?/i) ||
    text.match(/([0-9][0-9,]+)\s+input\s+tokens/i);
  const outputMatch =
    text.match(/output\s*(?:tokens)?[:\s]+([0-9][0-9,]*)\s*(?:tokens)?/i) ||
    text.match(/([0-9][0-9,]+)\s+output\s+tokens/i);

  // "Tokens used: 1,234,567 / 2,000,000"
  const totalUsedMatch = !inputMatch && !outputMatch
    ? text.match(/tokens\s+used[:\s]+([0-9][0-9,]*)/i)
    : null;

  // Model name: "claude-sonnet-4-5-20251001" or "claude-opus-4"
  const modelMatch = text.match(/claude-(?:opus|sonnet|haiku)[-\d.a-z]*/i);

  return {
    inputTokens: inputMatch ? clean(inputMatch[1]) : totalUsedMatch ? clean(totalUsedMatch[1]) : undefined,
    outputTokens: outputMatch ? clean(outputMatch[1]) : undefined,
    modelName: modelMatch ? modelMatch[0].toLowerCase() : undefined,
  };
}

export function parseUsage(text: string): ClaudeUsageParsed {
  // \s* tolerates TUI output where inter-word spaces are stripped by pipe-pane
  const session = extractSection(text, /Current\s*session/i);
  const week = extractSection(text, /Current\s*week/i);

  const creditsOff = /usage\s+credits?\s+are?\s+off/i.test(text);
  const creditsOn  = /usage\s+credits?\s+are?\s+on/i.test(text);
  const usageCreditsEnabled = creditsOff ? false : creditsOn ? true : undefined;

  const { inputTokens, outputTokens, modelName } = parseTokenCounts(text);

  return {
    sessionPct:           session?.pct,
    sessionResets:        session?.resetsRaw ? utcToSydney(session.resetsRaw) : undefined,
    sessionResetsAt:      session?.resetsRaw ? parseUTCResetTime(session.resetsRaw) ?? undefined : undefined,
    weekPct:              week?.pct,
    weekResets:           week?.resetsRaw ? utcToSydney(week.resetsRaw) : undefined,
    weekResetsAt:         week?.resetsRaw ? parseUTCResetTime(week.resetsRaw) ?? undefined : undefined,
    usageCreditsEnabled,
    sessionInputTokens:   inputTokens,
    sessionOutputTokens:  outputTokens,
    modelName,
  };
}

export function looksLikeUsage(text: string): boolean {
  return /Current\s*session/i.test(text) || /Current\s*week/i.test(text) || /%\s*used/i.test(text);
}

// ─── ANSI / terminal control stripping ───────────────────────────────────────

/**
 * Strip ANSI escape sequences and terminal control characters from raw
 * pipe-pane output.  pipe-pane captures the byte stream as-is, including
 * cursor-positioning codes, color codes, and alternate-screen sequences —
 * none of which appear in `tmux capture-pane -p` output.
 *
 * Handles:
 *   - CSI sequences:  ESC [ ... final-byte  (colors, cursor, erase, …)
 *   - OSC sequences:  ESC ] ... ST           (window title, hyperlinks, …)
 *   - Other ESC + single char
 *   - Carriage returns (\r)
 *   - Non-printable control chars (NUL–BS, VT, FF, SO–US, DEL)
 */
export function stripAnsi(raw: string): string {
  return raw
    // CSI sequences — param bytes include <>=! in addition to 0-9;? for private modes
    .replace(/\x1b\[[0-9;?<>=!]*[A-Za-z@]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")    // OSC sequences
    .replace(/\x1b[^[\]]/g, "")                            // other ESC + char
    .replace(/\x1b/g, "")                                  // stray ESC
    .replace(/\r/g, "")                                    // carriage returns
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");   // control chars
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

// ─── Completion block detection ──────────────────────────────────────────────

/**
 * Returns true when a valid structured completion block appears in the pane
 * text with matching taskId, status=completed, and nonce.
 *
 * Expected format (each field on its own line, no extra whitespace):
 *   [WORKERAI_RESULT]
 *   taskId: <taskId>
 *   status: completed
 *   nonce: <nonce>
 *   [/WORKERAI_RESULT]
 *
 * All three fields must match exactly. Scans all blocks in the text and
 * returns true as soon as one valid block is found.
 */
export function detectCompletionBlock(
  paneText: string,
  expectedTaskId: string,
  expectedNonce: string,
): boolean {
  if (!expectedTaskId || !expectedNonce) return false;

  let pos = 0;
  while (true) {
    const startIdx = paneText.indexOf(COMPLETION_BLOCK_START, pos);
    if (startIdx === -1) return false;

    const endIdx = paneText.indexOf(COMPLETION_BLOCK_END, startIdx + COMPLETION_BLOCK_START.length);
    if (endIdx === -1) return false;

    const block = paneText.slice(startIdx + COMPLETION_BLOCK_START.length, endIdx);
    const taskIdMatch = block.match(/^taskId:\s*(.+)$/m);
    const statusMatch = block.match(/^status:\s*(.+)$/m);
    const nonceMatch  = block.match(/^nonce:\s*(.+)$/m);

    if (
      taskIdMatch?.[1].trim() === expectedTaskId &&
      statusMatch?.[1].trim() === "completed" &&
      nonceMatch?.[1].trim() === expectedNonce
    ) {
      return true;
    }

    pos = startIdx + 1;
  }
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
 *
 * A bare `>` is only treated as Claude's main idle prompt when the immediately
 * preceding non-empty tail line does NOT look like a sub-dialog question (e.g.
 * "Create file? [y/n]").  Such lines appear when Claude Code asks for
 * confirmation and renders the input cursor on the following line — without
 * this guard those mid-dialog `>` lines trigger false-positive idle detection.
 */
export function classifyIdlePane(pane: string): IdleClassification {
  const lines = pane.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-6);

  // Patterns that identify a sub-dialog question on the line immediately
  // before a bare `>`, e.g. "Create /tmp/file.txt? [y/n]".
  const SUB_DIALOG_PRECEDING = /\[y\/n\]|\[Y\/n\]|\[yes\/no\]/i;

  const hasPrompt = tail.some((l, i) => {
    if (!/^[>❯]\s*$/.test(l)) return false;
    // If the immediately preceding tail line looks like a sub-dialog question,
    // this `>` is a continuation input cursor, not the Claude idle prompt.
    if (i > 0 && SUB_DIALOG_PRECEDING.test(tail[i - 1])) return false;
    return true;
  });

  const busyPattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\bThinking\b|esc to interrupt/i;
  const isBusy = tail.some((l) => busyPattern.test(l));
  return { isIdle: hasPrompt && !isBusy, hasPrompt, isBusy };
}
