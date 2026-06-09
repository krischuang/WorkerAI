import { Client } from "ssh2";
import * as fs from "fs";
import { validateSshKeyPath } from "./ssh-key-path";

const TIMEOUT_MS = 15_000;

export const ALLOWED_COMMANDS = [
  "whoami",
  "hostname",
  "pwd",
  "uptime",
  "df -h",
  "free -m",
  "node -v",
  "npm -v",
  "git --version",
  "docker --version",
  "claude --version",
] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export interface ServerConfig {
  host: string;
  username: string;
  port: number;
  sshKeyPath: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function resolveKeyPath(keyPath: string): string {
  const result = validateSshKeyPath(keyPath);
  if (!result.ok) throw new Error(`Refusing SSH connection: ${result.error}`);
  return result.resolved;
}

// Core SSH execution — no allowlist enforcement, callers decide policy.
// Pass an AbortSignal to close the SSH connection when the caller cancels.
export function execSSH(
  config: ServerConfig,
  command: string,
  timeoutMs = TIMEOUT_MS,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Cancelled", "AbortError"));
      return;
    }

    const conn = new Client();

    function cleanup(err?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      conn.end();
      if (err) reject(err);
    }

    function onAbort() {
      cleanup(new DOMException("Command cancelled", "AbortError"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      cleanup(
        new Error(`SSH command timed out after ${Math.round(timeoutMs / 1000)} seconds`)
      );
    }, timeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          cleanup(err);
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          conn.end();
          resolve({ stdout, stderr, exitCode: code });
        });

        stream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      });
    });

    conn.on("error", (err) => { cleanup(err); });

    const keyPath = resolveKeyPath(config.sshKeyPath);
    let privateKey: Buffer;
    try {
      privateKey = fs.readFileSync(keyPath);
    } catch {
      cleanup(
        new Error(`Cannot read SSH key at "${keyPath}". Check that the path exists and is readable.`)
      );
      return;
    }

    conn.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey,
      readyTimeout: timeoutMs,
    });
  });
}

// Allowlist-enforced wrapper — used by the environment check buttons.
export function runSSHCommand(
  config: ServerConfig,
  command: AllowedCommand
): Promise<CommandResult> {
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
    return Promise.reject(new Error(`Command not in allowlist: ${command}`));
  }
  return execSSH(config, command);
}

export async function testConnection(
  config: ServerConfig
): Promise<{ success: boolean; message: string }> {
  try {
    const { stdout } = await execSSH(config, "whoami");
    return { success: true, message: `Connected. Remote user: ${stdout.trim()}` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
