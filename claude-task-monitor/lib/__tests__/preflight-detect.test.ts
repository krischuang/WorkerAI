/**
 * Tests for classifyPreflightPane — the tail-window pre-flight detector.
 *
 * KEY INVARIANT: a rate-limit or auth error message that appears in the pane
 * history (more than PREFLIGHT_TAIL_LINES non-empty lines above the bottom)
 * must NOT trigger a detection.  Only errors in the recent tail count.
 */

import { describe, it, expect } from "vitest";
import {
  classifyPreflightPane,
  PREFLIGHT_TAIL_LINES,
  cleanPane,
} from "../usage-parser";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pane(...lines: string[]): string {
  return cleanPane(lines.join("\n"));
}

/** N distinct filler lines with content — used to push older lines out of the tail window. */
function filler(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `  Output line ${i + 1}`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// More than PREFLIGHT_TAIL_LINES filler lines — anything before these is
// guaranteed to be outside the tail window.
const ENOUGH_FILLER = filler(PREFLIGHT_TAIL_LINES + 5);

// ─── Stale / historical output ────────────────────────────────────────────────

describe("classifyPreflightPane — stale output in pane history", () => {
  it("ignores a rate-limit message buried beyond the tail window", () => {
    const p = pane(
      "  Error: rate_limit_error",
      "  Too many requests. Please wait before trying again.",
      ...ENOUGH_FILLER,
      ">",                            // current prompt at the bottom
    );
    expect(classifyPreflightPane(p).status).toBe("ok");
  });

  it("ignores a 'rate-limit' hyphenated variant in pane history", () => {
    const p = pane(
      "  rate-limit exceeded — retry in 60 s",
      ...ENOUGH_FILLER,
      ">",
    );
    expect(classifyPreflightPane(p).status).toBe("ok");
  });

  it("ignores a 'not logged in' auth error buried beyond the tail window", () => {
    const p = pane(
      "✗ Not logged in.",
      "Run 'claude login' to authenticate.",
      ...ENOUGH_FILLER,
      ">",
    );
    expect(classifyPreflightPane(p).status).toBe("ok");
  });

  it("ignores a 'please log in' auth error buried beyond the tail window", () => {
    const p = pane(
      "  Please log in to continue using Claude.",
      ...ENOUGH_FILLER,
      ">",
    );
    expect(classifyPreflightPane(p).status).toBe("ok");
  });

  it("ignores a session-unavailable error buried beyond the tail window", () => {
    const p = pane(
      "  Session unavailable — reconnecting",
      ...ENOUGH_FILLER,
      ">",
    );
    expect(classifyPreflightPane(p).status).toBe("ok");
  });
});

// ─── Fresh / current output ───────────────────────────────────────────────────

describe("classifyPreflightPane — fresh output in recent tail", () => {
  it("detects a rate-limit message in the recent tail", () => {
    const p = pane(
      ...filler(5),
      "  Error: rate_limit_error",
      "  Too many requests. Please wait before trying again.",
    );
    expect(classifyPreflightPane(p).status).toBe("rate_limited");
  });

  it("detects 'rate-limit' hyphenated variant in the recent tail", () => {
    const p = pane(...filler(3), "  rate-limit exceeded");
    expect(classifyPreflightPane(p).status).toBe("rate_limited");
  });

  it("detects 'too many requests' variant in the recent tail", () => {
    const p = pane(...filler(3), "  Too many requests — please wait.");
    expect(classifyPreflightPane(p).status).toBe("rate_limited");
  });

  it("detects 'not logged in' auth error in the recent tail", () => {
    const p = pane(
      ...filler(5),
      "✗ Not logged in.",
      "Run 'claude login' to authenticate.",
    );
    expect(classifyPreflightPane(p).status).toBe("auth_required");
  });

  it("detects 'please log in' variant in the recent tail", () => {
    const p = pane(...filler(3), "  Please log in to continue.");
    expect(classifyPreflightPane(p).status).toBe("auth_required");
  });

  it("detects 'run claude login' variant in the recent tail", () => {
    const p = pane(...filler(3), "  Run claude login to continue.");
    expect(classifyPreflightPane(p).status).toBe("auth_required");
  });

  it("detects session unavailable in the recent tail", () => {
    const p = pane(...filler(3), "  Session unavailable");
    expect(classifyPreflightPane(p).status).toBe("session_unavailable");
  });

  it("detects 'claude is not connected' in the recent tail", () => {
    const p = pane(...filler(3), "  Claude is not connected.");
    expect(classifyPreflightPane(p).status).toBe("session_unavailable");
  });
});

// ─── Normal prompt state ──────────────────────────────────────────────────────

describe("classifyPreflightPane — normal/ok state", () => {
  it("returns ok for a normal idle pane", () => {
    const p = pane("  Analyzed 42 files.", "  Done.", ">", "claude-3-sonnet · 12 tokens/s");
    expect(classifyPreflightPane(p).status).toBe("ok");
  });

  it("returns ok for an empty pane", () => {
    expect(classifyPreflightPane("").status).toBe("ok");
  });

  it("returns ok for a whitespace-only pane", () => {
    expect(classifyPreflightPane("   \n  \n  ").status).toBe("ok");
  });

  it("returns ok when only the ❯ prompt is present", () => {
    const p = pane("❯", "claude-3-opus · context 10k/200k");
    expect(classifyPreflightPane(p).status).toBe("ok");
  });
});

// ─── Detection metadata ───────────────────────────────────────────────────────

describe("classifyPreflightPane — metadata", () => {
  it("tailLines contains at most PREFLIGHT_TAIL_LINES entries", () => {
    const p = pane(...filler(100));
    const { tailLines } = classifyPreflightPane(p);
    expect(tailLines.length).toBeLessThanOrEqual(PREFLIGHT_TAIL_LINES);
  });

  it("tailLines contains exactly the non-empty content lines for small panes", () => {
    const p = pane("line 1", "line 2", ">");
    const { tailLines } = classifyPreflightPane(p);
    expect(tailLines).toHaveLength(3);
  });

  it("detectedAt is a Date within the current call's time bracket", () => {
    const before = new Date();
    const { detectedAt } = classifyPreflightPane(pane(">"));
    const after = new Date();
    expect(detectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(detectedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("detectedAt is present even for an ok classification", () => {
    const { detectedAt, status } = classifyPreflightPane(pane(">"));
    expect(status).toBe("ok");
    expect(detectedAt).toBeInstanceOf(Date);
  });

  it("tailLines are strings", () => {
    const { tailLines } = classifyPreflightPane(pane("a", "b", "c"));
    expect(tailLines.every((l) => typeof l === "string")).toBe(true);
  });
});

// ─── Tail-window boundary ─────────────────────────────────────────────────────

describe("classifyPreflightPane — tail-window boundary", () => {
  it("does NOT detect an error that sits exactly one line beyond the window", () => {
    // Build: 1 error line, then exactly PREFLIGHT_TAIL_LINES filler lines.
    // The error is at position 0; tail starts at position 1.
    const p = pane(
      "  rate-limit exceeded",
      ...filler(PREFLIGHT_TAIL_LINES),
    );
    expect(classifyPreflightPane(p).status).toBe("ok");
  });

  it("DOES detect an error that sits exactly at the tail-window boundary", () => {
    // Build: 1 filler line, then 1 error line, then PREFLIGHT_TAIL_LINES - 1 more fillers.
    // The error lands at index 1 of the full list; the tail covers the last
    // PREFLIGHT_TAIL_LINES entries, which includes it.
    const p = pane(
      "  historical filler",             // outside window
      "  rate-limit exceeded",           // inside window
      ...filler(PREFLIGHT_TAIL_LINES - 1),
    );
    expect(classifyPreflightPane(p).status).toBe("rate_limited");
  });
});
