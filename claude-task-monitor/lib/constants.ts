export const USAGE_THRESHOLD = 90;

/** Cooldown applied to an agent after any terminal task status (completed/failed/needs_review). */
export const AGENT_COOLDOWN_MS = 30_000; // 30 seconds

/** Directory on remote servers where wrapper scripts and done-files are written. */
export const RUN_DIR = "/tmp/workerai-runs";

/** Lines of log output to store in DB paneCapture when reading a done-file. */
export const LOG_TAIL_LINES = 200;

/**
 * Claude model pricing in USD per 1 million tokens (as of mid-2025).
 * Used to estimate cost from token counts parsed from /usage output.
 * Values are blended input+output rates — actual cost depends on ratio.
 */
export const CLAUDE_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Claude 4 family
  "claude-opus-4":          { inputPerM: 15.00, outputPerM: 75.00 },
  "claude-sonnet-4":        { inputPerM:  3.00, outputPerM: 15.00 },
  "claude-haiku-4":         { inputPerM:  0.80, outputPerM:  4.00 },
  // Claude 3.7 / 3.5 family
  "claude-opus-3-5":        { inputPerM: 15.00, outputPerM: 75.00 },
  "claude-sonnet-3-7":      { inputPerM:  3.00, outputPerM: 15.00 },
  "claude-sonnet-3-5":      { inputPerM:  3.00, outputPerM: 15.00 },
  "claude-haiku-3-5":       { inputPerM:  0.80, outputPerM:  4.00 },
  // Defaults when model is unknown
  "default":                { inputPerM:  3.00, outputPerM: 15.00 },
};

/** Estimate USD cost from token counts. Falls back to sonnet pricing if model not found. */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model = "default",
): number {
  const pricing =
    CLAUDE_PRICING[model] ??
    Object.entries(CLAUDE_PRICING).find(([k]) => model.toLowerCase().includes(k.replace("claude-", "").replace(/-/g, "")))?.[1] ??
    CLAUDE_PRICING["default"];
  return (inputTokens / 1_000_000) * pricing.inputPerM + (outputTokens / 1_000_000) * pricing.outputPerM;
}

/**
 * Buffer added to the scheduled resume time after a usage reset.
 * The Claude CLI caches usage state for the lifetime of the process — restarting
 * the session ensures /usage reflects the actual post-reset quota.
 * We schedule the restart slightly AFTER the reset so the quota has fully rolled over.
 */
export const POST_RESET_RESTART_BUFFER_MS = 5 * 60 * 1000; // 5 minutes after quota reset

/** Global default task timeout in minutes when no task/server/agent override is set. */
export const DEFAULT_TASK_TIMEOUT_MIN = 120;

/** Structured completion block delimiters Claude must output to signal task completion. */
export const COMPLETION_BLOCK_START = "[WORKERAI_RESULT]";
export const COMPLETION_BLOCK_END = "[/WORKERAI_RESULT]";

/**
 * Structured validation-evidence block delimiters. Required (in addition to the completion
 * block above) for tasks where Task.isAutonomous is true — see lib/prompt-sanitiser.ts and the
 * completion handling in instrumentation.node.ts.
 */
export const VALIDATION_BLOCK_START = "[WORKERAI_VALIDATION]";
export const VALIDATION_BLOCK_END = "[/WORKERAI_VALIDATION]";

/** Lines of tmux scrollback to capture when scanning for the completion block. */
export const COMPLETION_SCAN_LINES = 200;

/**
 * Lines of tmux scrollback to capture when polling for scan findings.
 * Must be large enough to hold the full prompt + Claude's response.
 * A gap-analysis prompt with 50 tasks can be 250+ lines; Claude's response
 * adds another 300-600 lines, so 2000 provides comfortable headroom.
 */
export const SCAN_CAPTURE_LINES = 2000;

/** Default timeout for polling a tmux pane for scan findings (5 minutes). */
export const SCAN_POLL_TIMEOUT_MS = 300_000;

/** Polling interval for scan findings. */
export const SCAN_POLL_INTERVAL_MS = 15_000;

/** Number of consecutive scan failures before auto-improvement is paused for a project. */
export const SCAN_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Minimum time (ms) a task must have been running before the idle-pane fallback
 * can mark it completed. Guards against false positives during startup or brief
 * gaps between tasks. Only fires when the nonce marker is absent.
 */
export const IDLE_FALLBACK_MIN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Maximum time (ms) to wait for Claude to finish inserting suggestions into the
 * database during an improvement scan.  Configurable via the
 * IMPROVEMENT_SCAN_TIMEOUT_MS environment variable (value in milliseconds).
 * Defaults to 10 minutes.
 */
export const IMPROVEMENT_SCAN_TIMEOUT_MS =
  parseInt(process.env.IMPROVEMENT_SCAN_TIMEOUT_MS ?? "0") || 10 * 60_000;

/** Polling interval (ms) when waiting for Claude to go idle after a scan prompt. */
export const IMPROVEMENT_SCAN_IDLE_POLL_MS = 20_000;

/**
 * Minimum time (ms) to wait before the first idle check after sending the scan
 * prompt — gives Claude time to start processing before we sample the pane.
 */
export const IMPROVEMENT_SCAN_MIN_WAIT_MS = 30_000;
