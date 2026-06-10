import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseUTCResetTime,
  toSydney,
  utcToSydney,
  extractSection,
  parseUsage,
  looksLikeUsage,
  cleanPane,
  classifyPreflightPane,
  PREFLIGHT_TAIL_LINES,
} from "../usage-parser";

// ─── parseUTCResetTime ────────────────────────────────────────────────────────

describe("parseUTCResetTime", () => {
  // Pin "now" to 2026-06-09T12:00:00Z so time-only tests are deterministic.
  const FIXED_NOW = new Date("2026-06-09T12:00:00.000Z");

  beforeEach(() => { vi.setSystemTime(FIXED_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("parses 'Ham/pm' format — future time today", () => {
    const d = parseUTCResetTime("3pm"); // 15:00 UTC — after 12:00
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(15);
    expect(d!.getUTCMinutes()).toBe(0);
    expect(d!.toISOString().startsWith("2026-06-09")).toBe(true);
  });

  it("parses 'Ham/pm' format — past time today → rolls to tomorrow", () => {
    const d = parseUTCResetTime("9am"); // 09:00 UTC — before 12:00
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(9);
    expect(d!.toISOString().startsWith("2026-06-10")).toBe(true);
  });

  it("parses 'H:Mam/pm' format with minutes", () => {
    const d = parseUTCResetTime("3:10pm");
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(15);
    expect(d!.getUTCMinutes()).toBe(10);
  });

  it("handles 12pm (noon) correctly", () => {
    const d = parseUTCResetTime("12pm");
    expect(d!.getUTCHours()).toBe(12);
  });

  it("handles 12am (midnight) correctly", () => {
    const d = parseUTCResetTime("12am");
    expect(d!.getUTCHours()).toBe(0);
  });

  it("parses 'Mon DD, Ham/pm' date+time format", () => {
    const d = parseUTCResetTime("Jun 15, 9am");
    expect(d).not.toBeNull();
    expect(d!.getUTCMonth()).toBe(5); // June = 5
    expect(d!.getUTCDate()).toBe(15);
    expect(d!.getUTCHours()).toBe(9);
  });

  it("parses 'Mon DD, H:Mam/pm' date+time with minutes", () => {
    const d = parseUTCResetTime("Jun 15, 3:10pm");
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(15);
    expect(d!.getUTCMinutes()).toBe(10);
  });

  it("rolls date+time to next year when date has already passed", () => {
    // Jan 1 has already passed relative to Jun 9
    const d = parseUTCResetTime("Jan 1, 9am");
    expect(d!.getUTCFullYear()).toBe(2027);
  });

  it("returns null for unrecognised format", () => {
    expect(parseUTCResetTime("")).toBeNull();
    expect(parseUTCResetTime("tomorrow")).toBeNull();
    expect(parseUTCResetTime("Xyz 15, 9am")).toBeNull();
  });

  it("is case-insensitive for am/pm and month", () => {
    const lower = parseUTCResetTime("jun 15, 9AM");
    expect(lower).not.toBeNull();
    expect(lower!.getUTCMonth()).toBe(5);
  });

  it("handles 12pm (noon) in date+time format", () => {
    const d = parseUTCResetTime("Jun 15, 12pm");
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(12); // 12pm stays 12 — no +12
  });

  it("handles 12am (midnight) in date+time format", () => {
    const d = parseUTCResetTime("Jun 15, 12am");
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(0); // 12am → 0
  });
});

// ─── toSydney ────────────────────────────────────────────────────────────────

describe("toSydney", () => {
  it("returns a string ending with (Sydney)", () => {
    const d = new Date("2026-06-10T03:10:00Z");
    expect(toSydney(d)).toMatch(/\(Sydney\)$/);
  });

  it("includes the formatted date and time components", () => {
    const d = new Date("2026-06-10T03:10:00Z");
    const result = toSydney(d);
    expect(result).toContain("Jun");
    expect(result).toContain("10");
  });
});

// ─── utcToSydney ─────────────────────────────────────────────────────────────

describe("utcToSydney", () => {
  beforeEach(() => { vi.setSystemTime(new Date("2026-06-09T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("converts a valid UTC string to Sydney display string", () => {
    const result = utcToSydney("3pm");
    expect(result).toContain("(Sydney)");
  });

  it("returns the original string when parsing fails", () => {
    expect(utcToSydney("not-a-time")).toBe("not-a-time");
  });
});

// ─── extractSection ───────────────────────────────────────────────────────────

describe("extractSection", () => {
  const SAMPLE = `
Current session
██████████████ 100% used
Resets 3:10pm (UTC)

Current week (all models)
█████           10% used
Resets Jun 15, 9am (UTC)
`.trim();

  it("extracts session percent and resets from session section", () => {
    const result = extractSection(SAMPLE, /Current session/i);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(100);
    expect(result!.resetsRaw).toBe("3:10pm");
  });

  it("extracts week percent and resets from week section", () => {
    const result = extractSection(SAMPLE, /Current week/i);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(10);
    expect(result!.resetsRaw).toBe("Jun 15, 9am");
  });

  it("returns null when section heading is not found", () => {
    expect(extractSection(SAMPLE, /Nonexistent section/i)).toBeNull();
  });

  it("returns null when section has neither % nor Resets", () => {
    expect(extractSection("Current session\nno data here", /Current session/i)).toBeNull();
  });

  it("handles 0% used", () => {
    const text = "Current session\n0% used\nResets 9am (UTC)";
    const result = extractSection(text, /Current session/i);
    expect(result!.pct).toBe(0);
  });

  it("handles section with % used but no Resets line — resetsRaw is empty string", () => {
    const text = "Current session\n75% used";
    const result = extractSection(text, /Current session/i);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(75);
    expect(result!.resetsRaw).toBe("");
  });

  it("handles section with Resets line but no % used — pct defaults to 0", () => {
    const text = "Current session\nResets 9am (UTC)";
    const result = extractSection(text, /Current session/i);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(0);
    expect(result!.resetsRaw).toBe("9am");
  });
});

// ─── parseUsage ──────────────────────────────────────────────────────────────

describe("parseUsage", () => {
  beforeEach(() => { vi.setSystemTime(new Date("2026-06-09T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  const FULL_OUTPUT = `
Current session
██████████████ 100% used
Resets 3:10pm (UTC)

Current week (all models)
█████           10% used
Resets Jun 15, 9am (UTC)
`.trim();

  it("parses both session and week from full output", () => {
    const result = parseUsage(FULL_OUTPUT);
    expect(result.sessionPct).toBe(100);
    expect(result.weekPct).toBe(10);
  });

  it("populates sessionResetsAt as a Date", () => {
    const result = parseUsage(FULL_OUTPUT);
    expect(result.sessionResetsAt).toBeInstanceOf(Date);
  });

  it("populates weekResetsAt as a Date", () => {
    const result = parseUsage(FULL_OUTPUT);
    expect(result.weekResetsAt).toBeInstanceOf(Date);
  });

  it("populates display strings for both sections", () => {
    const result = parseUsage(FULL_OUTPUT);
    expect(result.sessionResets).toContain("(Sydney)");
    expect(result.weekResets).toContain("(Sydney)");
  });

  it("returns undefined fields when output is empty", () => {
    const result = parseUsage("");
    expect(result.sessionPct).toBeUndefined();
    expect(result.weekPct).toBeUndefined();
    expect(result.sessionResetsAt).toBeUndefined();
    expect(result.weekResetsAt).toBeUndefined();
  });

  it("handles partial output with only session section", () => {
    const partial = "Current session\n50% used\nResets 9am (UTC)";
    const result = parseUsage(partial);
    expect(result.sessionPct).toBe(50);
    expect(result.weekPct).toBeUndefined();
  });

  it("sets resetsAt to undefined when resets string is present but unparseable", () => {
    // "tomorrow" is not a recognised format — parseUTCResetTime returns null
    const text = "Current session\n50% used\nResets tomorrow (UTC)\n\nCurrent week (all models)\n20% used\nResets next-week (UTC)";
    const result = parseUsage(text);
    expect(result.sessionPct).toBe(50);
    expect(result.sessionResetsAt).toBeUndefined();
    expect(result.weekPct).toBe(20);
    expect(result.weekResetsAt).toBeUndefined();
  });
});

// ─── looksLikeUsage ───────────────────────────────────────────────────────────

describe("looksLikeUsage", () => {
  it("returns true for text with 'Current session'", () => {
    expect(looksLikeUsage("Current session\n100% used")).toBe(true);
  });

  it("returns true for text with 'Current week'", () => {
    expect(looksLikeUsage("Current week (all models)\n10% used")).toBe(true);
  });

  it("returns true for text with '% used'", () => {
    expect(looksLikeUsage("55% used")).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(looksLikeUsage("auth required")).toBe(false);
    expect(looksLikeUsage("")).toBe(false);
    expect(looksLikeUsage("command not found")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(looksLikeUsage("CURRENT SESSION")).toBe(true);
  });
});

// ─── cleanPane ───────────────────────────────────────────────────────────────

describe("cleanPane", () => {
  it("strips carriage returns", () => {
    expect(cleanPane("line1\r\nline2\r\n")).toBe("line1\nline2");
  });

  it("strips trailing spaces and tabs tmux adds for padding", () => {
    expect(cleanPane("hello   \nworld\t\t")).toBe("hello\nworld");
  });

  it("trims leading and trailing blank lines", () => {
    expect(cleanPane("\n\nhello\n\n")).toBe("hello");
  });

  it("preserves internal blank lines", () => {
    const result = cleanPane("section1\n\nsection2");
    expect(result).toBe("section1\n\nsection2");
  });

  it("handles empty string", () => {
    expect(cleanPane("")).toBe("");
  });

  it("handles only whitespace", () => {
    expect(cleanPane("   \n   \r\n   ")).toBe("");
  });
});

// ─── classifyPreflightPane ────────────────────────────────────────────────────

describe("classifyPreflightPane", () => {
  it("returns ok for a normal idle pane", () => {
    const result = classifyPreflightPane("Some task output.\n\n>\n");
    expect(result.status).toBe("ok");
  });

  it("returns auth_required when 'not logged in' appears in the tail", () => {
    const result = classifyPreflightPane("✗ Not logged in.\nRun claude login to authenticate.");
    expect(result.status).toBe("auth_required");
  });

  it("returns auth_required when 'please log in' appears in the tail", () => {
    expect(classifyPreflightPane("Please log in first.").status).toBe("auth_required");
  });

  it("returns auth_required when 'run claude login' appears in the tail", () => {
    expect(classifyPreflightPane("Run claude login to continue.").status).toBe("auth_required");
  });

  it("returns rate_limited when 'rate-limit' appears in the tail", () => {
    const result = classifyPreflightPane("Error: rate_limit_error\nToo many requests.");
    expect(result.status).toBe("rate_limited");
  });

  it("returns rate_limited when 'too many requests' appears in the tail", () => {
    expect(classifyPreflightPane("too many requests, slow down").status).toBe("rate_limited");
  });

  it("returns session_unavailable for matching pattern", () => {
    expect(classifyPreflightPane("Session unavailable. Reconnect.").status).toBe("session_unavailable");
  });

  it("returns session_unavailable when claude is not connected", () => {
    expect(classifyPreflightPane("Claude is not connected.").status).toBe("session_unavailable");
  });

  it("returns session_unavailable when claude is not available", () => {
    expect(classifyPreflightPane("Claude is not available right now.").status).toBe("session_unavailable");
  });

  it("auth_required takes precedence over rate_limited (first match wins)", () => {
    const pane = "not logged in\nrate-limit error";
    expect(classifyPreflightPane(pane).status).toBe("auth_required");
  });

  it("returns detectedAt as a recent Date", () => {
    const before = Date.now();
    const result = classifyPreflightPane(">");
    expect(result.detectedAt).toBeInstanceOf(Date);
    expect(result.detectedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("returns the inspected lines in tailLines", () => {
    const result = classifyPreflightPane("line one\nline two\n>");
    expect(result.tailLines).toContain("line one");
    expect(result.tailLines).toContain("line two");
    expect(result.tailLines).toContain(">");
  });

  it("excludes blank lines from tailLines", () => {
    const result = classifyPreflightPane("a\n\n\nb\n");
    expect(result.tailLines).not.toContain("");
  });

  it(`only inspects the last ${PREFLIGHT_TAIL_LINES} non-empty lines`, () => {
    // Put a rate-limit error far above the tail window, then fill with clean lines.
    const oldError = "rate-limit error from ages ago";
    const cleanLines = Array.from({ length: PREFLIGHT_TAIL_LINES }, (_, i) => `clean line ${i + 1}`);
    const pane = [oldError, ...cleanLines].join("\n");
    // The error is now beyond the tail window — should not trigger rate_limited.
    expect(classifyPreflightPane(pane).status).toBe("ok");
  });

  it("still detects errors that are within the tail window", () => {
    // Fill with lines then put the error just inside the window.
    const prefix = Array.from({ length: PREFLIGHT_TAIL_LINES - 2 }, (_, i) => `ok line ${i}`);
    const pane = [...prefix, "rate-limit error"].join("\n");
    expect(classifyPreflightPane(pane).status).toBe("rate_limited");
  });

  it("returns ok for an empty pane", () => {
    expect(classifyPreflightPane("").status).toBe("ok");
  });

  it("is case-insensitive for all status patterns", () => {
    expect(classifyPreflightPane("NOT LOGGED IN").status).toBe("auth_required");
    expect(classifyPreflightPane("RATE-LIMIT EXCEEDED").status).toBe("rate_limited");
    expect(classifyPreflightPane("SESSION UNAVAILABLE").status).toBe("session_unavailable");
  });
});

describe("PREFLIGHT_TAIL_LINES", () => {
  it("is a number in the valid range (20–50)", () => {
    expect(typeof PREFLIGHT_TAIL_LINES).toBe("number");
    expect(PREFLIGHT_TAIL_LINES).toBeGreaterThanOrEqual(20);
    expect(PREFLIGHT_TAIL_LINES).toBeLessThanOrEqual(50);
  });
});
