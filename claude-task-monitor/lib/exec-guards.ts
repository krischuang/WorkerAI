/**
 * Security guards for the /api/servers/[id]/exec route.
 * Extracted as pure functions so they can be unit-tested without a
 * running HTTP server or real SSH connection.
 */

export const MAX_COMMAND_LENGTH = 4_096;

/**
 * Returns true if the request's Origin header comes from localhost.
 * Pass the value of request.headers.get("origin") — null means no header,
 * which is allowed (direct / server-side calls have no Origin).
 *
 * Prevents cross-site request forgery: a malicious page visited in the
 * user's browser cannot POST to the localhost API.
 */
export function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    // Node's URL parser wraps IPv6 addresses in brackets: "[::1]"
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Patterns for commands that are irreversible and destructive at the OS
 * level. Arbitrary commands remain allowed — intentional product decision
 * for a local-only tool (see CLAUDE.md). This blocklist only covers
 * operations that silently destroy the remote host with no recovery path.
 */
export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // rm -rf / or rm -fr / (any flag combo containing r+f targeting /)
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/\s*$|\/\s+)/i,
  // Filesystem format
  /\bmkfs\b/i,
  // dd writing to a raw block device
  /\bdd\b.*\bof=\/dev\/(s|h|vd|xvd|nvme)/i,
  // Fork bomb
  /:\s*\(\s*\)\s*\{.*\|.*:.*\}.*;\s*:/,
  // Wipe entire disk
  /\b(shred|wipefs)\b.*\/dev\//i,
];

export function isDestructiveCommand(cmd: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd));
}
