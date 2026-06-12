import * as path from "path";
import * as os from "os";
import * as fs from "fs";

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

  // Enforce home-directory boundary.
  // Allow paths under the current user's home directory OR any user's home
  // under /home/<username>/ — this handles the case where the process runs as
  // root (os.homedir() = /root) but SSH keys live in /home/<user>/.ssh/.
  // We verify that /home/<username> is an existing directory to prevent
  // traversal attacks that land inside /home/ (e.g. ~/.ssh/../../etc/passwd
  // normalises to /home/etc/passwd on systems where HOME is under /home/).
  const home = os.homedir();
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  const isUnderCurrentHome = resolved === home || resolved.startsWith(homeWithSep);
  const isUnderSystemHomes = (() => {
    const parts = resolved.split(path.sep); // ["", "home", "<user>", ...]
    if (parts[1] !== "home" || !parts[2] || parts.length < 4) return false;
    try { return fs.statSync(path.join("/home", parts[2])).isDirectory(); } catch { return false; }
  })();
  if (!isUnderCurrentHome && !isUnderSystemHomes) {
    return {
      ok: false,
      error: `sshKeyPath must be within a home directory (${home})`,
    };
  }

  return { ok: true, resolved };
}
