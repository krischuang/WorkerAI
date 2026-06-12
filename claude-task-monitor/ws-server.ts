import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { Client } from "ssh2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./app/generated/prisma/client";
import pg from "pg";
import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage } from "http";
import { validateSshKeyPath } from "./lib/ssh-key-path";
import {
  makeStore, checkLimits, recordAdmit, recordRelease,
  MAX_TOTAL_CONNECTIONS, MAX_CONNECTIONS_PER_IP, RATE_WINDOW_MS, RATE_LIMIT_MAX,
  validateWsConnectParams,
} from "./lib/ws-rate-limit";

const WS_PORT = Number(process.env.WS_PORT ?? 3099);
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const rateLimitStore = makeStore();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 3,
  idleTimeoutMillis: 30_000,
});

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const wss = new WebSocketServer({ port: WS_PORT });

function resolveKeyPath(keyPath: string): string {
  const result = validateSshKeyPath(keyPath);
  if (!result.ok) throw new Error(`Refusing SSH connection: ${result.error}`);
  return result.resolved;
}

function getClientIp(req: IncomingMessage): string {
  // Use the direct socket address — do NOT trust X-Forwarded-For from the client
  // for rate limiting, as it can be spoofed.
  return req.socket.remoteAddress ?? "unknown";
}

type InMsg =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
  // ── Origin check — CSRF protection ────────────────────────────────────────
  //
  // Security review (relaxation from localhost-only → same-hostname):
  //
  // THREAT: a malicious page visited in the user's browser sends a WebSocket
  // upgrade to this server from a different origin (cross-site WebSocket
  // hijacking).  The browser always supplies an Origin header on upgrades, so
  // we can use it as a CSRF token.
  //
  // PREVIOUS POLICY: reject any origin that is not `http(s)://localhost[:<port>]`.
  // This blocked the app when accessed via a remote hostname or tunnel URL
  // (e.g. a company VPN address, an ngrok tunnel, a secondary NIC IP) because
  // the Next.js page would be served from that hostname, not localhost, yet the
  // browser would send that hostname as the Origin.
  //
  // CURRENT POLICY: allow the request when either:
  //   a) No Origin header (direct/programmatic connection — no browser involved).
  //   b) Origin hostname is `localhost` (legacy and test tooling).
  //   c) Origin hostname matches the HTTP Host header hostname — i.e. the page
  //      was served from the same host that is receiving the WS connection.
  //
  // WHY THIS IS SAFE: a cross-site attacker's page always has a different
  // hostname from the server's Host header.  The browser cannot spoof Origin.
  // The Host header reflects the TCP target chosen by the browser, which a
  // cross-origin page cannot manipulate to match its own origin.
  //
  // EXPANDED ATTACK SURFACE vs. localhost-only:
  //   Any page served by the *same host* (any port) can now open a WS
  //   connection.  In practice the host is a single-user machine or a VPN-
  //   accessible box, so this is acceptable.  Remaining mitigations:
  //     • Password-protected REST API (session cookie required for the app)
  //     • SSH private key never leaves the server; never sent to the browser
  //     • Per-IP connection rate limiting + total connection cap (below)
  //     • 30-minute idle session timeout
  //
  // NOTE: `isLocalOrigin` in lib/exec-guards.ts serves the REST API exec
  // routes and uses a different, stricter policy (explicit ALLOWED_ORIGINS
  // list).  The two checks are intentionally separate and must NOT be merged.
  const origin = req.headers.origin ?? "";
  if (origin && !/^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    const reqHost = req.headers.host?.replace(/:\d+$/, "") ?? "";
    const originHost = (() => { try { return new URL(origin).hostname; } catch { return ""; } })();
    if (originHost !== reqHost) {
      ws.close(1008, "Forbidden");
      return;
    }
  }

  // Connection limit + per-IP rate limit
  const clientIp = getClientIp(req);
  const now = Date.now();
  const result = checkLimits(clientIp, now, rateLimitStore, {
    maxTotal:     MAX_TOTAL_CONNECTIONS,
    maxPerIp:     MAX_CONNECTIONS_PER_IP,
    rateMax:      RATE_LIMIT_MAX,
    rateWindowMs: RATE_WINDOW_MS,
  });
  if (!result.admitted) {
    const msg = result.reason === "total_cap"
      ? "Server overloaded"
      : result.reason === "ip_cap"
        ? "Too many connections from your address"
        : "Connection rate limit exceeded";
    ws.close(result.reason === "total_cap" ? 1013 : 1008, msg);
    return;
  }
  recordAdmit(clientIp, now, rateLimitStore, RATE_WINDOW_MS);

  // Release the slot when this socket closes for any reason.
  // "close" always fires after "error" in the ws library, so one listener suffices.
  ws.once("close", () => recordRelease(clientIp, rateLimitStore));

  const url = new URL(req.url ?? "/", `http://localhost:${WS_PORT}`);
  const serverId = url.searchParams.get("serverId");
  const agentId = url.searchParams.get("agentId");

  function send(payload: object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  const connectErr = validateWsConnectParams(serverId, agentId);
  if (connectErr) {
    send({ type: "error", message: connectErr });
    ws.close();
    return;
  }

  // Resolve SSH credentials and optional tmux session from DB
  let sshHost: string;
  let sshPort: number;
  let sshUsername: string;
  let sshKeyPath: string;
  let attachTmuxSession: string | null = null;

  try {
    if (agentId) {
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        include: { server: true },
      });
      if (!agent) {
        send({ type: "error", message: "Agent not found" });
        ws.close();
        return;
      }
      sshHost = agent.server.host;
      sshPort = agent.server.port;
      sshUsername = agent.server.username;
      sshKeyPath = agent.server.sshKeyPath;
      attachTmuxSession = agent.tmuxSession;
    } else {
      const server = await prisma.server.findUnique({ where: { id: serverId! } });
      if (!server) {
        send({ type: "error", message: "Server not found" });
        ws.close();
        return;
      }
      sshHost = server.host;
      sshPort = server.port;
      sshUsername = server.username;
      sshKeyPath = server.sshKeyPath;
    }
  } catch {
    send({ type: "error", message: "Database error" });
    ws.close();
    return;
  }

  let keyPath: string;
  try {
    keyPath = resolveKeyPath(sshKeyPath);
  } catch (e) {
    send({ type: "error", message: e instanceof Error ? e.message : "Invalid SSH key path" });
    ws.close();
    return;
  }
  let privateKey: Buffer;
  try {
    privateKey = fs.readFileSync(keyPath);
  } catch {
    send({ type: "error", message: `Cannot read SSH key: ${path.basename(keyPath)}` });
    ws.close();
    return;
  }

  const conn = new Client();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stream: any = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      send({ type: "disconnected", reason: "Session timed out (30 min idle)" });
      conn.end();
    }, IDLE_TIMEOUT_MS);
  }

  function cleanup() {
    if (idleTimer) clearTimeout(idleTimer);
    try { conn.end(); } catch { /* already closed */ }
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as InMsg;
      resetIdle();
      if (msg.type === "input" && stream) {
        stream.write(msg.data);
      } else if (msg.type === "resize" && stream) {
        stream.setWindow(msg.rows, msg.cols, 0, 0);
      }
    } catch {
      /* ignore malformed messages */
    }
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  conn.on("ready", () => {
    conn.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (err, sh) => {
      if (err) {
        send({ type: "error", message: err.message });
        ws.close();
        return;
      }

      stream = sh;
      send({ type: "connected" });

      // When connecting to an agent, auto-attach to its tmux session
      if (attachTmuxSession) {
        sh.write(`tmux attach-session -t ${attachTmuxSession} 2>/dev/null || tmux new-session -s ${attachTmuxSession}\n`);
      }
      resetIdle();

      // Base64-encode binary output so ANSI/UTF-8 sequences survive JSON
      sh.on("data", (data: Buffer) => {
        send({ type: "output", data: data.toString("base64") });
        resetIdle();
      });

      sh.stderr?.on("data", (data: Buffer) => {
        send({ type: "output", data: data.toString("base64") });
      });

      sh.on("close", () => {
        send({ type: "disconnected" });
        ws.close();
        conn.end();
      });
    });
  });

  conn.on("error", (err) => {
    send({ type: "error", message: err.message });
    ws.close();
  });

  conn.connect({
    host: sshHost,
    port: sshPort,
    username: sshUsername,
    privateKey,
    readyTimeout: 30_000,
  });
});

wss.on("listening", () => {
  console.log(`\x1b[32m✓\x1b[0m SSH WebSocket terminal  ws://localhost:${WS_PORT}`);
});

wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\x1b[31m✗\x1b[0m Port ${WS_PORT} is already in use.\n` +
      `  Set a different port with:  WS_PORT=3098 npm run ws\n` +
      `  Then update WS_URL in app/_components/InteractiveTerminal.tsx`
    );
  } else {
    console.error("\x1b[31m✗\x1b[0m WebSocket server error:", err.message);
  }
  process.exit(1);
});

process.on("SIGTERM", () => { wss.close(); void pool.end(); });
process.on("SIGINT", () => { wss.close(); void pool.end(); });
