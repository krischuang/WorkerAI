export const USAGE_THRESHOLD = 90;

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

/** Lines of tmux scrollback to capture when scanning for the completion block. */
export const COMPLETION_SCAN_LINES = 1000;

/**
 * Minimum time (ms) a task must have been running before the idle-pane fallback
 * can mark it completed. Guards against false positives during startup or brief
 * gaps between tasks. Only fires when the nonce marker is absent.
 */
export const IDLE_FALLBACK_MIN_MS = 5 * 60 * 1000; // 5 minutes
