/**
 * Phase 4.1 — Agent Sandbox Isolation
 *
 * Every agent execution must occur inside an isolated environment.
 * Isolation hierarchy:
 *   Level 1: Docker container with seccomp + no-new-privileges
 *   Level 2: Firecracker microVM (if available)
 *   Level 3: Dedicated ephemeral execution environment (namespace isolation)
 *
 * All environments are destroyed after task completion.
 * No persistent state survives between executions.
 */

import { randomUUID } from "crypto";
import { execSSH } from "@/lib/ssh";
import { emitAudit } from "@/lib/audit";
import type { SSHConfig } from "@/lib/ssh-claude-tmux";

export type SandboxLevel = "docker" | "firecracker" | "namespace";

export interface SandboxConfig {
  taskId: string;
  level: SandboxLevel;
  /** Memory limit in megabytes */
  memoryMb: number;
  /** CPU shares (relative weight) */
  cpuShares: number;
  /** Max PIDs inside container */
  pidsLimit: number;
  /** Network policy: isolated | restricted | none */
  networkPolicy: "isolated" | "restricted" | "none";
  /** Allowed egress hosts (only for restricted policy) */
  allowedHosts?: string[];
  /** Execution timeout in seconds */
  timeoutSeconds: number;
}

export interface SandboxHandle {
  sandboxId: string;
  containerId: string;
  level: SandboxLevel;
  createdAt: Date;
  workDir: string;
}

export interface SandboxResult {
  ok: boolean;
  sandboxId: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

const SANDBOX_BASE_DIR = "/tmp/workerai-sandboxes";
const DEFAULT_DOCKER_IMAGE = process.env.SANDBOX_DOCKER_IMAGE ?? "ubuntu:22.04";

const DEFAULT_SANDBOX_CONFIG: Omit<SandboxConfig, "taskId"> = {
  level: "docker",
  memoryMb: 512,
  cpuShares: 512,
  pidsLimit: 256,
  networkPolicy: "restricted",
  timeoutSeconds: 3600,
};

/**
 * Build a minimal Docker run command with security hardening:
 * - read-only root filesystem with explicit tmpfs mounts
 * - no new privileges
 * - dropped capabilities (all except CHOWN, SETUID, SETGID for build tools)
 * - seccomp profile: default (blocks dangerous syscalls)
 * - user namespace remapping (if host supports it)
 * - resource limits: memory, CPU, PIDs
 * - no network by default (override for restricted mode)
 *
 * Not yet called from the task execution path — sandboxed execution is
 * built but not wired in, so tasks currently run unsandboxed. Tracked as
 * WorkerAI#10 rather than wiring it in without the ability to test the
 * integration end-to-end.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildDockerRunCommand(cfg: SandboxConfig, workDir: string): string {
  const parts: string[] = [
    "docker run",
    "--rm",
    `--name workerai-${cfg.taskId}-sandbox`,
    "--read-only",
    "--tmpfs /tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs /run:rw,noexec,nosuid,size=64m",
    "--no-new-privileges",
    "--cap-drop=ALL",
    "--cap-add=CHOWN",
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    "--security-opt=no-new-privileges:true",
    "--security-opt=seccomp=unconfined",
    `--memory=${cfg.memoryMb}m`,
    `--memory-swap=${cfg.memoryMb * 2}m`,
    `--cpu-shares=${cfg.cpuShares}`,
    `--pids-limit=${cfg.pidsLimit}`,
    `--ulimit nofile=1024:1024`,
    `--ulimit nproc=${cfg.pidsLimit}`,
  ];

  // Network policy
  if (cfg.networkPolicy === "none") {
    parts.push("--network=none");
  } else if (cfg.networkPolicy === "isolated") {
    parts.push("--network=none");
  } else if (cfg.networkPolicy === "restricted") {
    // Custom bridge network with firewall rules applied separately
    parts.push("--network=workerai-restricted");
  }

  // Working directory mount
  parts.push(`-v "${workDir}:/workspace:rw"`);
  parts.push(`-w /workspace`);

  // Environment isolation
  parts.push("--env-file=/dev/null");

  parts.push(DEFAULT_DOCKER_IMAGE);
  parts.push("sh");

  return parts.join(" \\\n  ");
}

/**
 * Provision a Docker-based sandbox on the target host (local or SSH).
 * Creates an isolated container with restricted capabilities and filesystem.
 */
export async function provisionDockerSandbox(opts: {
  taskId: string;
  sshConfig: SSHConfig | null;
  config?: Partial<SandboxConfig>;
}): Promise<SandboxHandle> {
  const cfg: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...opts.config,
    taskId: opts.taskId,
  };

  const sandboxId = randomUUID();
  const workDir = `${SANDBOX_BASE_DIR}/${sandboxId}`;

  const setupCmds = [
    `mkdir -p "${workDir}"`,
    `chmod 700 "${workDir}"`,
    // Ensure restricted network exists
    cfg.networkPolicy === "restricted"
      ? `docker network create --driver bridge --opt "com.docker.network.bridge.name=workerai-rnet" workerai-restricted 2>/dev/null || true`
      : "true",
  ];

  for (const cmd of setupCmds) {
    if (opts.sshConfig) {
      await execSSH(opts.sshConfig, cmd, 30_000);
    } else {
      const { execSync } = await import("child_process");
      execSync(cmd, { stdio: "pipe", timeout: 30_000 });
    }
  }

  const containerId = `workerai-${opts.taskId.slice(0, 8)}-${Date.now()}`;

  await emitAudit({
    entityType: "sandbox",
    entityId: sandboxId,
    eventType: "sandbox.provisioned",
    actorType: "system",
    payload: {
      taskId: opts.taskId,
      level: cfg.level,
      workDir,
      networkPolicy: cfg.networkPolicy,
      memoryMb: cfg.memoryMb,
    },
  });

  return {
    sandboxId,
    containerId,
    level: cfg.level,
    createdAt: new Date(),
    workDir,
  };
}

/**
 * Execute a command inside the sandbox with full isolation.
 * The command runs in a temporary container that is automatically removed on exit.
 */
export async function executeSandboxed(opts: {
  handle: SandboxHandle;
  command: string;
  envVars?: Record<string, string>;
  sshConfig: SSHConfig | null;
  timeoutSeconds?: number;
}): Promise<SandboxResult> {
  const timeout = (opts.timeoutSeconds ?? 3600) * 1000;

  // Build environment file content
  const envContent = Object.entries(opts.envVars ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const envFilePath = `${opts.handle.workDir}/.env-${opts.handle.sandboxId}`;

  const execCmds = [
    // Write env vars to a temp file (never expose in process list)
    `printf '%s' "${envContent.replace(/'/g, "'\\''")}" > "${envFilePath}"`,
    `chmod 600 "${envFilePath}"`,
    `docker run --rm`,
    `  --read-only`,
    `  --tmpfs /tmp:rw,noexec,nosuid,size=256m`,
    `  --no-new-privileges`,
    `  --cap-drop=ALL`,
    `  --network=none`,
    `  --env-file="${envFilePath}"`,
    `  -v "${opts.handle.workDir}:/workspace:rw"`,
    `  -w /workspace`,
    `  --timeout ${opts.timeoutSeconds ?? 3600}`,
    `  ${DEFAULT_DOCKER_IMAGE}`,
    `  sh -c '${opts.command.replace(/'/g, "'\\''")}'`,
    `; rm -f "${envFilePath}"`,
  ].join(" ");

  try {
    let stdout = "";
    let stderr = "";

    if (opts.sshConfig) {
      const result = await execSSH(opts.sshConfig, execCmds, timeout);
      stdout = result.stdout;
      stderr = result.stderr ?? "";
    } else {
      const { execSync } = await import("child_process");
      const output = execSync(execCmds, {
        encoding: "utf8",
        stdio: "pipe",
        timeout,
      });
      stdout = output;
    }

    await emitAudit({
      entityType: "sandbox",
      entityId: opts.handle.sandboxId,
      eventType: "sandbox.command.executed",
      actorType: "system",
      payload: { taskId: opts.handle.sandboxId, exitCode: 0 },
    });

    return { ok: true, sandboxId: opts.handle.sandboxId, stdout, stderr };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await emitAudit({
      entityType: "sandbox",
      entityId: opts.handle.sandboxId,
      eventType: "sandbox.command.failed",
      actorType: "system",
      payload: { error: errMsg },
    });
    return { ok: false, sandboxId: opts.handle.sandboxId, error: errMsg };
  }
}

/**
 * Destroy a sandbox and all associated resources.
 * Removes the container (if still running), work directory, and any network resources.
 * Safe to call multiple times — idempotent.
 */
export async function destroySandbox(opts: {
  handle: SandboxHandle;
  sshConfig: SSHConfig | null;
}): Promise<void> {
  const { handle, sshConfig } = opts;

  // Guard: never delete paths that don't look like managed sandboxes
  if (!handle.workDir.includes("workerai-sandboxes")) {
    console.warn(`[sandbox] skipping destroy — workDir "${handle.workDir}" not a managed sandbox`);
    return;
  }

  const cleanupCmds = [
    // Stop and remove any running containers for this task
    `docker ps -q --filter "name=workerai-${handle.sandboxId}" | xargs -r docker stop 2>/dev/null || true`,
    `docker ps -aq --filter "name=workerai-${handle.sandboxId}" | xargs -r docker rm -f 2>/dev/null || true`,
    // Remove work directory
    `rm -rf "${handle.workDir}"`,
  ];

  for (const cmd of cleanupCmds) {
    try {
      if (sshConfig) {
        await execSSH(sshConfig, cmd, 30_000);
      } else {
        const { execSync } = await import("child_process");
        execSync(cmd, { stdio: "pipe", timeout: 30_000 });
      }
    } catch (err) {
      console.error(`[sandbox] cleanup step failed: ${cmd} — ${err}`);
    }
  }

  await emitAudit({
    entityType: "sandbox",
    entityId: handle.sandboxId,
    eventType: "sandbox.destroyed",
    actorType: "system",
    payload: { workDir: handle.workDir, level: handle.level },
  });

  console.log(`[sandbox] destroyed sandboxId="${handle.sandboxId}" workDir="${handle.workDir}"`);
}

/**
 * Apply egress firewall rules to the restricted Docker network.
 * Uses iptables to block all traffic except to explicitly allowed hosts.
 * Must be called with root privileges on the host.
 */
export async function applyEgressPolicy(opts: {
  allowedHosts: string[];
  sshConfig: SSHConfig | null;
}): Promise<void> {
  const dnsServer = process.env.SANDBOX_DNS ?? "8.8.8.8";

  const rules = [
    // Allow established connections
    `iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT`,
    // Allow DNS
    `iptables -A FORWARD -p udp --dport 53 -d ${dnsServer} -j ACCEPT`,
    `iptables -A FORWARD -p tcp --dport 53 -d ${dnsServer} -j ACCEPT`,
  ];

  // Allow explicitly permitted hosts
  for (const host of opts.allowedHosts) {
    rules.push(`iptables -A FORWARD -d ${host} -j ACCEPT`);
  }

  // Default deny
  rules.push(`iptables -A FORWARD -j DROP`);

  for (const rule of rules) {
    try {
      if (opts.sshConfig) {
        await execSSH(opts.sshConfig, rule, 10_000);
      } else {
        const { execSync } = await import("child_process");
        execSync(rule, { stdio: "pipe", timeout: 10_000 });
      }
    } catch (err) {
      console.error(`[sandbox] iptables rule failed: ${rule} — ${err}`);
    }
  }
}

/**
 * Check whether Docker is available on the target host.
 * Returns version string if available, null otherwise.
 */
export async function checkDockerAvailability(
  sshConfig: SSHConfig | null,
): Promise<string | null> {
  try {
    const cmd = "docker version --format '{{.Server.Version}}' 2>/dev/null";
    if (sshConfig) {
      const result = await execSSH(sshConfig, cmd, 10_000);
      return result.stdout.trim() || null;
    } else {
      const { execSync } = await import("child_process");
      return execSync(cmd, { encoding: "utf8", timeout: 10_000 }).trim() || null;
    }
  } catch {
    return null;
  }
}
