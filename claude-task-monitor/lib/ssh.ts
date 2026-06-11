import { Client } from "ssh2";
import * as fs from "fs";
import { validateSshKeyPath } from "./ssh-key-path";

const TIMEOUT_MS = 15_000;
const KEEPALIVE_MS = 30_000;
const CONN_IDLE_MS = 5 * 60 * 1000;

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

// ── SSH Connection Pool ───────────────────────────────────────────────────────
// Reuses one TCP/SSH connection per server across multiple execSSH calls.
// Reduces connection count from O(commands) to O(servers), eliminating the
// SSH storm that was exhausting memory and hitting MaxStartups limits.

interface PoolEntry {
  promise: Promise<Client>;
  alive: boolean;
  lastUsedAt: number;
}

declare global {
  var _sshPool: Map<string, PoolEntry> | undefined;
  var _sshPoolCleanupStarted: boolean | undefined;
}

function getPool(): Map<string, PoolEntry> {
  if (!globalThis._sshPool) globalThis._sshPool = new Map();
  if (!globalThis._sshPoolCleanupStarted) {
    globalThis._sshPoolCleanupStarted = true;
    const t = setInterval(evictIdle, 60_000);
    // Don't block process exit on the cleanup timer.
    if (typeof t === "object" && t !== null && "unref" in t) (t as NodeJS.Timeout).unref();
  }
  return globalThis._sshPool;
}

function evictIdle() {
  const pool = globalThis._sshPool;
  if (!pool) return;
  const now = Date.now();
  for (const [key, entry] of pool) {
    if (!entry.alive || now - entry.lastUsedAt > CONN_IDLE_MS) {
      pool.delete(key);
      if (entry.alive) entry.promise.then((c) => c.end()).catch(() => {});
    }
  }
}

function poolKey(config: ServerConfig): string {
  return `${config.username}@${config.host}:${config.port}:${config.sshKeyPath}`;
}

function resolveKeyPath(keyPath: string): string {
  const result = validateSshKeyPath(keyPath);
  if (!result.ok) throw new Error(`Refusing SSH connection: ${result.error}`);
  return result.resolved;
}

async function getConnection(
  config: ServerConfig,
  connectTimeoutMs: number
): Promise<Client> {
  const pool = getPool();
  const key = poolKey(config);

  const existing = pool.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    try {
      const client = await existing.promise;
      if (existing.alive) return client;
    } catch {
      pool.delete(key);
    }
  }

  // Read the private key before touching the pool so a bad path throws
  // immediately without creating a dangling pool entry.
  const keyPath = resolveKeyPath(config.sshKeyPath);
  let privateKey: Buffer;
  try {
    privateKey = fs.readFileSync(keyPath);
  } catch {
    throw new Error(
      `Cannot read SSH key at "${keyPath}". Check that the path exists and is readable.`
    );
  }

  // Create the promise and entry before calling conn.connect() so that any
  // concurrent getConnection() call for the same key awaits the same promise
  // instead of opening a second TCP connection.
  let resolveConn!: (c: Client) => void;
  let rejectConn!: (e: Error) => void;
  const promise = new Promise<Client>((res, rej) => {
    resolveConn = res;
    rejectConn = rej;
  });

  const entry: PoolEntry = { promise, alive: true, lastUsedAt: Date.now() };
  pool.set(key, entry);

  const conn = new Client();

  const connectTimer = setTimeout(() => {
    conn.end();
    entry.alive = false;
    pool.delete(key);
    rejectConn(
      new Error(`SSH connection timed out connecting to ${config.host}:${config.port}`)
    );
  }, connectTimeoutMs);

  conn.once("ready", () => {
    clearTimeout(connectTimer);
    resolveConn(conn);
  });

  conn.once("error", (err) => {
    clearTimeout(connectTimer);
    entry.alive = false;
    if (pool.get(key) === entry) pool.delete(key);
    rejectConn(err);
  });

  conn.once("close", () => {
    entry.alive = false;
    if (pool.get(key) === entry) pool.delete(key);
  });

  conn.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    privateKey,
    readyTimeout: connectTimeoutMs,
    keepaliveInterval: KEEPALIVE_MS,
    keepaliveCountMax: 3,
  });

  try {
    return await promise;
  } catch (err) {
    if (pool.get(key) === entry) pool.delete(key);
    throw err;
  }
}

function execOnClient(
  client: Client,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Cancelled", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        new Error(`SSH command timed out after ${Math.round(timeoutMs / 1000)} seconds`)
      );
    }, timeoutMs);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Command cancelled", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";

      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: code });
      });

      stream.on("data", (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    });
  });
}

// Core SSH execution — no allowlist enforcement, callers decide policy.
// Pass an AbortSignal to close the SSH connection when the caller cancels.
export async function execSSH(
  config: ServerConfig,
  command: string,
  timeoutMs = TIMEOUT_MS,
  signal?: AbortSignal
): Promise<CommandResult> {
  if (signal?.aborted) {
    throw new DOMException("Cancelled", "AbortError");
  }

  const connectTimeout = Math.min(timeoutMs, 15_000);
  const client = await getConnection(config, connectTimeout);

  try {
    return await execOnClient(client, command, timeoutMs, signal);
  } catch (err) {
    // On connection-level errors (not timeouts or cancellations), evict the
    // stale pooled connection and retry once with a fresh one.
    const isConnErr =
      err instanceof Error &&
      !err.message.includes("timed out") &&
      !(err instanceof DOMException);

    if (isConnErr) {
      const pool = getPool();
      const key = poolKey(config);
      const entry = pool.get(key);
      if (entry) {
        entry.alive = false;
        pool.delete(key);
        entry.promise.then((c) => c.end()).catch(() => {});
      }
      const freshClient = await getConnection(config, connectTimeout);
      return execOnClient(freshClient, command, timeoutMs, signal);
    }

    throw err;
  }
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
