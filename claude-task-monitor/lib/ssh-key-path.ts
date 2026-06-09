import * as path from "path";
import * as os from "os";

export type SshKeyPathResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/**
 * Validate and resolve an SSH key path.
 *
 * Rules enforced:
 *  - Non-empty string with no null bytes or newlines
 *  - Absolute or ~/…  — relative paths are rejected
 *  - No .. traversal after normalisation
 *  - Resolved path must be within the current user's home directory,
 *    which prevents path traversal to /etc/passwd, /proc/self/environ, etc.
 *
 * Returns the canonicalised absolute path on success.
 */
export function validateSshKeyPath(raw: unknown): SshKeyPathResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "sshKeyPath must be a non-empty string" };
  }

  if (/[\0\n\r]/.test(raw)) {
    return { ok: false, error: "sshKeyPath contains invalid characters" };
  }

  // Expand ~/
  const expanded = raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw;

  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: "sshKeyPath must be an absolute path or start with ~/" };
  }

  // Canonicalise without filesystem access — eliminates . and .. segments
  const resolved = path.normalize(expanded);

  // Enforce home-directory boundary
  const home = os.homedir();
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (resolved !== home && !resolved.startsWith(homeWithSep)) {
    return {
      ok: false,
      error: `sshKeyPath must be within the home directory (${home})`,
    };
  }

  return { ok: true, resolved };
}
