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
