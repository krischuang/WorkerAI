import { describe, it, expect } from "vitest";
import { classifyIdlePane, cleanPane } from "../usage-parser";

// Helper to build a realistic pane string from an array of lines
function pane(...lines: string[]): string {
  return cleanPane(lines.join("\n"));
}

// ─── Fixture: normal idle ─────────────────────────────────────────────────────
// Claude is waiting at the input prompt after completing a task.
const NORMAL_IDLE = pane(
  "  Analyzed 42 files.",
  "  Done.",
  "",
  ">",
  "claude-3-5-sonnet-20241022 · 12 tokens/s · context: 45k/200k",
);

// ─── Fixture: sub-prompt dialog ───────────────────────────────────────────────
// Claude is showing a tool-use permission dialog; no bare `>` prompt.
const SUB_PROMPT_DIALOG = pane(
  "╭──────────────────────────────────────────────────────────╮",
  "│ Claude wants to run a bash command                       │",
  "│                                                          │",
  "│   rm -rf /tmp/old_files                                  │",
  "│                                                          │",
  "│  ❯ Yes, allow once                                       │",
  "│    Yes, allow for this session                           │",
  "│    No, don't allow                                       │",
  "╰──────────────────────────────────────────────────────────╯",
);

// ─── Fixture: thinking state ──────────────────────────────────────────────────
// Claude is actively reasoning; "Thinking" appears in the tail.
const THINKING_STATE = pane(
  "  Reading src/index.ts ...",
  "  Reading src/utils.ts ...",
  "⠹ Thinking",
  "esc to interrupt",
);

// ─── Fixture: rate-limit message ─────────────────────────────────────────────
// API returned a rate-limit error; no idle prompt.
const RATE_LIMITED = pane(
  "  Calling API...",
  "  Error: rate_limit_error",
  "  Too many requests. Please wait before trying again.",
  "  (Retry in 60 s)",
);

// ─── Fixture: auth required ───────────────────────────────────────────────────
// Claude is not authenticated; no idle prompt.
const AUTH_REQUIRED = pane(
  "✗ Not logged in.",
  "Run 'claude login' to authenticate.",
);

// ─── Fixture: mid-command output ─────────────────────────────────────────────
// Claude is executing a command; spinner and interrupt hint are present.
const MID_COMMAND_OUTPUT = pane(
  "  Running: npm test",
  "  Test suite: 156 tests...",
  "⠋ Executing",
  "  stdout: ...passed 80/156",
  "esc to interrupt",
);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("classifyIdlePane — normal idle", () => {
  it("detects idle when bare > prompt is in the tail", () => {
    const result = classifyIdlePane(NORMAL_IDLE);
    expect(result.isIdle).toBe(true);
    expect(result.hasPrompt).toBe(true);
    expect(result.isBusy).toBe(false);
  });

  it("also recognises the ❯ glyph as an idle prompt", () => {
    const paneText = pane("Some output.", "❯", "claude-3-opus-20240229 · 8 t/s");
    const result = classifyIdlePane(paneText);
    expect(result.isIdle).toBe(true);
    expect(result.hasPrompt).toBe(true);
  });

  it("prompt does not need to be the very last line", () => {
    // Status-bar footer appears after the prompt — still idle
    const paneText = pane(
      "Output.",
      ">",
      "claude-3-5-sonnet · context: 10k/200k",
    );
    expect(classifyIdlePane(paneText).isIdle).toBe(true);
  });
});

describe("classifyIdlePane — sub-prompt dialogs", () => {
  it("is NOT idle when a tool-use permission dialog is shown", () => {
    const result = classifyIdlePane(SUB_PROMPT_DIALOG);
    expect(result.isIdle).toBe(false);
    expect(result.hasPrompt).toBe(false);
  });

  it("does not confuse ❯ inside a dialog box with an idle prompt", () => {
    // The ❯ inside '│  ❯ Yes │' is not at the start of the line
    const dialogLine = "│  ❯ Yes, allow once                                       │";
    expect(/^[>❯]\s*$/.test(dialogLine)).toBe(false);
  });
});

describe("classifyIdlePane — thinking state", () => {
  it("is NOT idle while Claude shows Thinking", () => {
    const result = classifyIdlePane(THINKING_STATE);
    expect(result.isIdle).toBe(false);
    expect(result.isBusy).toBe(true);
  });

  it("is NOT idle when Thinking and a prompt both appear in the tail", () => {
    // Rare transition state — still should not be treated as idle
    const paneText = pane("⠹ Thinking", "esc to interrupt", ">");
    const result = classifyIdlePane(paneText);
    expect(result.isIdle).toBe(false);
    expect(result.hasPrompt).toBe(true);
    expect(result.isBusy).toBe(true);
  });

  it("word-boundary check: 'Rethinking' does not trigger busy", () => {
    // "Thinking" only matches as a whole word
    const paneText = pane("Rethinking approach...", ">");
    const result = classifyIdlePane(paneText);
    expect(result.isBusy).toBe(false);
    expect(result.isIdle).toBe(true);
  });
});

describe("classifyIdlePane — rate-limit message", () => {
  it("is NOT idle when a rate-limit error is displayed", () => {
    const result = classifyIdlePane(RATE_LIMITED);
    expect(result.isIdle).toBe(false);
    expect(result.hasPrompt).toBe(false);
  });
});

describe("classifyIdlePane — auth required", () => {
  it("is NOT idle when the session is unauthenticated", () => {
    const result = classifyIdlePane(AUTH_REQUIRED);
    expect(result.isIdle).toBe(false);
    expect(result.hasPrompt).toBe(false);
  });
});

describe("classifyIdlePane — mid-command output", () => {
  it("is NOT idle while a command is executing (spinner + esc hint)", () => {
    const result = classifyIdlePane(MID_COMMAND_OUTPUT);
    expect(result.isIdle).toBe(false);
    expect(result.isBusy).toBe(true);
  });

  it("detects each individual spinner character as busy", () => {
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    for (const ch of spinners) {
      const paneText = pane("Running...", `${ch} working`);
      expect(classifyIdlePane(paneText).isBusy).toBe(true);
    }
  });

  it("'esc to interrupt' alone marks the pane as busy", () => {
    const paneText = pane("Output line 1.", "Output line 2.", "esc to interrupt");
    expect(classifyIdlePane(paneText).isBusy).toBe(true);
  });
});

describe("classifyIdlePane — tail window boundary", () => {
  it("ignores a prompt buried more than 6 lines from the end", () => {
    const paneText = pane(
      ">",           // prompt at the top — too far back
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",      // tail starts here
      "line 7",
    );
    expect(classifyIdlePane(paneText).isIdle).toBe(false);
  });

  it("detects a prompt that is exactly 6 lines from the end", () => {
    const paneText = pane(
      "earlier output",
      ">",         // sixth from the end
      "a",
      "b",
      "c",
      "d",
      "e",
    );
    expect(classifyIdlePane(paneText).isIdle).toBe(true);
  });
});

describe("classifyIdlePane — empty / blank pane", () => {
  it("returns not-idle for an empty pane", () => {
    expect(classifyIdlePane("").isIdle).toBe(false);
  });

  it("returns not-idle for a whitespace-only pane", () => {
    expect(classifyIdlePane("   \n  \n  ").isIdle).toBe(false);
  });
});
