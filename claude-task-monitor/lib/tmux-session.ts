/**
 * Opaque tmux session name generation for per-task sessions.
 *
 * Instead of the guessable/enumerable "claude_<taskId>" format, each task
 * session name is derived from HMAC(taskId, TMUX_SESSION_SECRET) so that:
 *   – Knowing a task ID does not reveal the session name.
 *   – Session names are not enumerable by external parties.
 *   – The same task always maps to the same session name (deterministic).
 *
 * Environment:
 *   TMUX_SESSION_SECRET — 32+ byte hex string (64+ hex chars).
 *   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Fallback: when TMUX_SESSION_SECRET is not set the function falls back to
 * the legacy "claude_<taskId>" format with a warning, so existing deployments
 * are not broken on upgrade.
 */

import { createHmac } from "crypto";

const HMAC_ALG = "sha256";
const SESSION_PREFIX = "t";

/**
 * Returns an opaque, tmux-safe session name for the given task ID.
 *
 * When TMUX_SESSION_SECRET is configured: HMAC-SHA256(taskId, secret) — first
 * 24 hex chars prefixed with "t", e.g. "t3a7f91c2b5e840d6…".
 * When the env var is absent: falls back to "claude_<taskId>" (legacy).
 */
export function opaqueSessionName(taskId: string): string {
  const secret = process.env.TMUX_SESSION_SECRET;
  if (!secret) {
    console.warn(
      "[security] TMUX_SESSION_SECRET is not set — tmux session names are predictable. " +
      "Set this env var to enable opaque session identifiers.",
    );
    return `claude_${taskId}`;
  }
  const hmac = createHmac(HMAC_ALG, Buffer.from(secret, "hex").length === 0 ? secret : Buffer.from(secret, "hex"));
  hmac.update(taskId);
  return `${SESSION_PREFIX}${hmac.digest("hex").slice(0, 24)}`;
}

/**
 * Verify that a given session name was derived from the supplied task ID.
 * Used in tests and diagnostic utilities.
 */
export function isSessionNameForTask(sessionName: string, taskId: string): boolean {
  return sessionName === opaqueSessionName(taskId);
}
