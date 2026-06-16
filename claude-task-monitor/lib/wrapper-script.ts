/**
 * Generates the bash wrapper script that WorkerAI uploads to remote servers.
 *
 * The wrapper runs Claude in non-interactive print mode (`claude --print`),
 * pipes all output to a durable log file, and writes a JSON done-file when
 * Claude exits.  The done-file is written atomically (tmp → mv) so the poller
 * never reads a partial file.
 *
 * All functions here are pure (no I/O) — they produce strings only.
 */

import { RUN_DIR } from "@/lib/constants";

// ── Path helpers ──────────────────────────────────────────────────────────────

export function doneFilePath(runId: string): string {
  return `${RUN_DIR}/${runId}.done.json`;
}

export function promptFilePath(runId: string): string {
  return `${RUN_DIR}/${runId}.prompt`;
}

export function wrapperScriptPath(runId: string): string {
  return `${RUN_DIR}/wrapper_${runId}.sh`;
}

export function logFilePath(runId: string): string {
  return `${RUN_DIR}/${runId}.log`;
}

// ── Claude command builder ─────────────────────────────────────────────────────

/**
 * Maps a ClaudePermissionMode to the CLI flags needed for `claude --print`.
 * Returns a space-separated string (may be empty for workspace_write).
 */
export function claudeFlagsForMode(mode: string): string {
  switch (mode) {
    case "read_only":
      return '--allowedTools "Read,Grep,Glob,LS,WebSearch,WebFetch"';
    case "full_autonomous":
      return "--dangerously-skip-permissions";
    case "workspace_write":
    default:
      return "";
  }
}

// ── Wrapper script generator ──────────────────────────────────────────────────

export interface WrapperOpts {
  taskId: string;
  /** Empty string for server-direct tasks (no agentId). */
  agentId: string;
  runId: string;
  /** Extra flags for the claude CLI (from claudeFlagsForMode). */
  claudeFlags: string;
  /** If set, HOME is exported to this path before running Claude. */
  workDir?: string;
}

/**
 * Returns the content of the bash wrapper script.
 *
 * Design decisions:
 *  - `set -euo pipefail` so unexpected errors do not silently pass.
 *  - PIPESTATUS[0] captures claude's exit code even though output is piped to tee.
 *  - Done-file is written via a tmp → mv rename so the poller never reads a
 *    half-written file (POSIX rename is atomic on the same filesystem).
 *  - The done-file is written in a `finally` pattern using a trap so it is
 *    written even if `set -e` would otherwise abort the script.
 */
export function buildWrapperScript(opts: WrapperOpts): string {
  const prompt  = promptFilePath(opts.runId);
  const log     = logFilePath(opts.runId);
  const done    = doneFilePath(opts.runId);
  const flags   = opts.claudeFlags ? ` ${opts.claudeFlags}` : "";
  const homeExport = opts.workDir ? `export HOME="${opts.workDir}"` : "";

  return `#!/usr/bin/env bash
set -euo pipefail

TASK_ID="${opts.taskId}"
AGENT_ID="${opts.agentId}"
RUN_ID="${opts.runId}"
DONE_FILE="${done}"
LOG_FILE="${log}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EXIT_CODE=1

cleanup() {
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"taskId":"%s","agentId":"%s","runId":"%s","exitCode":%s,"startedAt":"%s","finishedAt":"%s","logPath":"%s"}\\n' \\
    "$TASK_ID" "$AGENT_ID" "$RUN_ID" "$EXIT_CODE" "$STARTED_AT" "$finished_at" "$LOG_FILE" \\
    > "${done}.tmp" && mv "${done}.tmp" "$DONE_FILE"
}
trap cleanup EXIT

${homeExport}
claude${flags} --print "$(cat "${prompt}")" 2>&1 | tee "$LOG_FILE"
EXIT_CODE="\${PIPESTATUS[0]}"
`;
}
