import * as fs from "fs";
import * as path from "path";

/**
 * Validates SSH_KEY_PATH at application startup.
 *
 * - If SSH_KEY_PATH is not set: logs a warning (not fatal — servers may use
 *   individually configured key paths stored in the database).
 * - If SSH_KEY_PATH is set but the file is missing or unreadable: logs an
 *   error. In Docker this is always fatal because SSH_KEY_PATH is injected by
 *   docker-compose.yml; the entrypoint script enforces this before Node starts,
 *   so this path is a belt-and-suspenders check.
 * - Permissions (400/600): logs a warning only — Docker bind-mounts can
 *   surface host uid/gid mismatches that are harmless in practice.
 */
export function validateSshKeyEnv(): void {
  const keyPath = process.env.SSH_KEY_PATH;

  if (!keyPath) {
    console.warn(
      "[startup] SSH_KEY_PATH is not set. " +
        "For Docker, ensure it is configured in docker-compose.yml. " +
        "For host mode, add it to .env.local."
    );
    return;
  }

  if (!fs.existsSync(keyPath)) {
    console.error(`[startup] ERROR: SSH key not found at SSH_KEY_PATH="${keyPath}".`);
    console.error(
      "  In Docker: check that SSH_KEY_FILE on the host points to an existing file."
    );
    console.error(
      "  In host mode: verify SSH_KEY_PATH in your .env.local matches the actual path."
    );
    return;
  }

  try {
    fs.accessSync(keyPath, fs.constants.R_OK);
  } catch {
    console.error(`[startup] ERROR: SSH key is not readable: SSH_KEY_PATH="${keyPath}".`);
    console.error("  Check file permissions. The key should be owned by the running user.");
    return;
  }

  try {
    const stat = fs.statSync(keyPath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600) {
      console.warn(
        `[startup] WARNING: SSH key permissions are ${mode.toString(8)} ` +
          `(expected 400 or 600). Fix with: chmod 400 "${keyPath}"`
      );
    }
  } catch {
    // Non-fatal — stat failure is unusual if accessSync succeeded.
  }

  console.log(`[startup] SSH_KEY_PATH validated: ${keyPath}`);
}

let _artifactStoragePath: string | null = null;
let _artifactStorageWritable: boolean | null = null;

export function validateArtifactStoragePath(): void {
  const storagePath = process.env.ARTIFACT_STORAGE_PATH ?? path.join(process.cwd(), "artifacts");
  _artifactStoragePath = storagePath;

  try {
    fs.mkdirSync(storagePath, { recursive: true });
  } catch {
    // mkdirSync failed — likely an unwritable parent; the accessSync below will confirm
  }

  try {
    fs.accessSync(storagePath, fs.constants.W_OK);
    _artifactStorageWritable = true;
    console.log(`[startup] Artifact storage path validated: ${storagePath}`);
  } catch {
    _artifactStorageWritable = false;
    console.warn(
      `[startup] WARNING: ARTIFACT_STORAGE_PATH is not writable — artifact uploads will fail (path: ${storagePath})`
    );
  }
}

export function getArtifactStorageStatus(): { path: string; writable: boolean } | null {
  if (_artifactStoragePath === null || _artifactStorageWritable === null) return null;
  return { path: _artifactStoragePath, writable: _artifactStorageWritable };
}
