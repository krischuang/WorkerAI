import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseUTCResetTime,
  toSydney,
  utcToSydney,
  extractSection,
  parseUsage,
  looksLikeUsage,
  cleanPane,
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
