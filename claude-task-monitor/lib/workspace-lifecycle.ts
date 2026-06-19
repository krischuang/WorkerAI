/**
 * Workspace lifecycle management for remote-first task execution.
 *
 * Supports three workspace strategies (WorkspaceStrategy enum):
 *  - local_permanent  : existing behaviour — no temporary clone, workDir is fixed
 *  - temporary_clone  : shallow clone at task start, rm -rf on completion/failure
 *  - remote_api       : no local clone; file access goes through lib/github-api.ts
 *
 * Disk safety: clones are gated on a 500 MB free-space check executed on the
 * target server over SSH before any git commands run.
 */

import os from "os";
import path from "path";
import { execSSH } from "@/lib/ssh";
import { prisma } from "@/lib/prisma";
import type { SSHConfig } from "@/lib/ssh-claude-tmux";

const MIN_FREE_BYTES = 500 * 1024 * 1024; // 500 MB

export interface WorkspaceResult {
  workspaceDir: string;
}

/**
 * Reject branch names that contain shell metacharacters or path-traversal sequences.
 * Accepts the superset of names used by GitHub, GitLab, and Bitbucket CI systems.
 */
export function validateBranch(branch: string): void {
  if (!branch || !/^[a-zA-Z0-9/._-]{1,255}$/.test(branch)) {
    throw new Error(
      `Invalid branch name "${branch}": only alphanumeric characters, /, ., _, and - are allowed.`,
    );
  }
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("..")) {
    throw new Error(`Invalid branch name "${branch}": must not start/end with / or contain ..`);
  }
}

/**
 * Reject repository URLs that contain shell metacharacters or are not recognisable
 * git remote URL formats (https://, git@host:, ssh://, git://).
 */
export function validateRepoUrl(url: string): void {
  if (!url) throw new Error("Repository URL is required");
  if (/[\s;&|`$(){}<>!*?#\\]/.test(url)) {
    throw new Error(`Invalid repository URL: contains shell metacharacters`);
  }
  if (!/^(https?:\/\/|git@[^:]+:|ssh:\/\/|git:\/\/)/.test(url)) {
    throw new Error(`Invalid repository URL: must begin with https://, git@host:, ssh://, or git://`);
  }
}

/**
 * Check free disk space on the target server (or localhost when sshConfig is
 * null) and throw if less than MIN_FREE_BYTES are available.
 *
 * Uses `df -k <path>` which works on Linux and macOS.
 */
export async function checkDiskSpace(
  sshConfig: SSHConfig | null,
  checkPath: string,
): Promise<void> {
  const cmd = `df -k "${checkPath}" | awk 'NR==2{print $4}'`;
  let freeKb: number;

  if (sshConfig) {
    const result = await execSSH(sshConfig, cmd);
    freeKb = parseInt(result.stdout.trim(), 10);
  } else {
    const { execSync } = await import("child_process");
    freeKb = parseInt(execSync(cmd).toString().trim(), 10);
  }

  if (isNaN(freeKb) || freeKb * 1024 < MIN_FREE_BYTES) {
    throw new Error(
      `Insufficient disk space: ${freeKb} KB free on ${checkPath}. ` +
        `At least ${MIN_FREE_BYTES / 1024 / 1024} MB required.`,
    );
  }
}

/**
 * Provision a temporary workspace for a task that uses the `temporary_clone`
 * strategy.
 *
 * Steps:
 *  1. Verify ≥ 500 MB free on the target server's /tmp (or a custom base dir)
 *  2. Shallow-clone (--depth=1) the repository into a uniquely named tmpdir
 *  3. Persist the workspace path in Task.workspaceDir
 *
 * Returns the local (on the agent's server) absolute path to the workspace.
 */
export async function provisionTemporaryWorkspace(opts: {
  taskId: string;
  repoUrl: string;
  branch: string;
  sshConfig: SSHConfig | null;
  /** Optional base directory for clones (defaults to /tmp on remote, os.tmpdir() locally). */
  baseDir?: string;
}): Promise<WorkspaceResult> {
  validateBranch(opts.branch);
  validateRepoUrl(opts.repoUrl);

  const baseDir = opts.baseDir ?? (opts.sshConfig ? "/tmp" : os.tmpdir());
  const dirName = `workerai_${opts.taskId}_${Date.now()}`;
  const workspaceDir = path.posix.join(baseDir, dirName);

  // 1. Disk safety gate
  await checkDiskSpace(opts.sshConfig, baseDir);

  // 2. Shallow clone — never interpolate branch/repoUrl into a shell string.
  const cloneArgv = ["git", "clone", "--depth=1", "--branch", opts.branch, opts.repoUrl, workspaceDir];

  if (opts.sshConfig) {
    // SSH path must send a shell command; shell-quote each argument so no
    // special characters in branch or repoUrl can escape the argument boundary.
    const q = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
    await execSSH(opts.sshConfig, cloneArgv.map(q).join(" "), 120_000);
  } else {
    const { spawnSync } = await import("child_process");
    const result = spawnSync(cloneArgv[0], cloneArgv.slice(1), { stdio: "pipe", timeout: 120_000 });
    if (result.status !== 0) {
      throw new Error(`git clone failed: ${result.stderr?.toString().trim()}`);
    }
  }

  // 3. Persist workspace path
  await prisma.task.update({
    where: { id: opts.taskId },
    data: { workspaceDir },
  });

  console.log(
    `[workspace] provisioned taskId="${opts.taskId}" dir="${workspaceDir}" repo="${opts.repoUrl}"`,
  );
  return { workspaceDir };
}

/**
 * Tear down a temporary workspace after task completion or failure.
 *
 * Runs `rm -rf <workspaceDir>` on the server (or locally) and clears
 * Task.workspaceDir in the database.
 *
 * Safe to call multiple times — a missing directory is not an error.
 */
export async function cleanupWorkspace(opts: {
  taskId: string;
  workspaceDir: string;
  sshConfig: SSHConfig | null;
}): Promise<void> {
  const { workspaceDir } = opts;

  // Sanity guard: never delete the repo root or bare /tmp
  if (workspaceDir.length < 10 || !workspaceDir.includes("workerai_")) {
    console.warn(
      `[workspace] skipping cleanup — path "${workspaceDir}" doesn't look like a managed workspace`,
    );
    return;
  }

  const rmCmd = `rm -rf "${workspaceDir}"`;

  try {
    if (opts.sshConfig) {
      await execSSH(opts.sshConfig, rmCmd, 30_000);
    } else {
      const { execSync } = await import("child_process");
      execSync(rmCmd, { timeout: 30_000 });
    }
    console.log(
      `[workspace] cleaned up taskId="${opts.taskId}" dir="${workspaceDir}"`,
    );
  } catch (err) {
    // Log but do not rethrow — cleanup failure should not block task status updates
    console.error(
      `[workspace] cleanup failed for taskId="${opts.taskId}" dir="${workspaceDir}": ${err}`,
    );
  }

  // Clear workspace dir from DB regardless of rm success
  await prisma.task.update({
    where: { id: opts.taskId },
    data: { workspaceDir: null },
  }).catch((err) =>
    console.error(`[workspace] DB clear failed for taskId="${opts.taskId}": ${err}`),
  );
}

/**
 * Convenience: run cleanup for all tasks that still have a workspaceDir set
 * but are in a terminal state (completed / failed / archived).
 *
 * Called during startup validation or on-demand to reclaim leaked workspaces.
 * Only handles locally accessible workspaces (sshConfig = null path).
 */
export async function reclaimLeakedLocalWorkspaces(): Promise<void> {
  const leaked = await prisma.task.findMany({
    where: {
      workspaceDir: { not: null },
      status: { in: ["completed", "failed", "archived"] },
    },
    select: { id: true, workspaceDir: true },
  });

  if (leaked.length === 0) return;

  console.log(`[workspace] reclaiming ${leaked.length} leaked workspace(s)`);
  for (const task of leaked) {
    if (task.workspaceDir) {
      await cleanupWorkspace({
        taskId: task.id,
        workspaceDir: task.workspaceDir,
        sshConfig: null,
      });
    }
  }
}
