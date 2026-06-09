import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { Client } from "ssh2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./app/generated/prisma/client";
import pg from "pg";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { IncomingMessage } from "http";
import { validateSshKeyPath } from "./lib/ssh-key-path";

const WS_PORT = Number(process.env.WS_PORT ?? 3099);
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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

type InMsg =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
  // Allow same-host origins only (localhost or the server's own hostname/IP)
  const origin = req.headers.origin ?? "";
  if (origin && !/^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    const reqHost = req.headers.host?.replace(/:\d+$/, "") ?? "";
    const originHost = (() => { try { return new URL(origin).hostname; } catch { return ""; } })();
    if (originHost !== reqHost) {
      ws.close(1008, "Forbidden");
      return;
    }
  }

  const url = new URL(req.url ?? "/", `http://localhost:${WS_PORT}`);
  const serverId = url.searchParams.get("serverId");

  function send(payload: object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  if (!serverId) {
    send({ type: "error", message: "serverId is required" });
    ws.close();
    return;
  }

  let server;
  try {
    server = await prisma.server.findUnique({ where: { id: serverId } });
  } catch {
    send({ type: "error", message: "Database error" });
    ws.close();
    return;
  }

  if (!server) {
    send({ type: "error", message: "Server not found" });
    ws.close();
    return;
  }

  const keyPath = resolveKeyPath(server.sshKeyPath);
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
    host: server.host,
    port: server.port,
    username: server.username,
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
