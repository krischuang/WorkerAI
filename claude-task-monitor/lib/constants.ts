export const USAGE_THRESHOLD = 90;

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
