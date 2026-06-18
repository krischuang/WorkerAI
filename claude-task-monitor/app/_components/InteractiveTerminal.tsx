"use client";

// xterm.css must be a static side-effect import so Turbopack/webpack can bundle it.
// This file is only ever loaded via next/dynamic with ssr:false, so the CSS won't
// be evaluated during server-side rendering.
import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, useState } from "react";

// When served over HTTPS, route WebSocket through nginx (/ws) using wss://.
// In HTTP dev mode, connect directly to the standalone ws-server port.
const WS_URL =
  typeof window !== "undefined"
    ? window.location.protocol === "https:"
      ? `wss://${window.location.host}/ws`
      : `ws://${window.location.hostname}:3099`
    : "ws://localhost:3099";

// Exponential backoff delays in ms — caps at 30 s.
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_ATTEMPTS = 12; // give up after ~5 minutes of retrying

type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

interface Props {
  serverId?: string;
  agentId?: string;
  label: string;
}

export default function InteractiveTerminal({ serverId, agentId, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState,       setConnState]       = useState<ConnState>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [errorMsg,        setErrorMsg]        = useState("");

  // Stable refs that survive across reconnects without triggering re-renders.
  const termRef            = useRef<import("@xterm/xterm").Terminal | null>(null);
  const wsRef              = useRef<WebSocket | null>(null);
  const colsRef            = useRef(80);
  const rowsRef            = useRef(24);
  const mountedRef         = useRef(true);
  const attemptRef         = useRef(0);
  const reconnectTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function init() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !containerRef.current) return;

      // ── Create the Terminal once — kept alive across reconnects so the
      //    scrollback buffer is preserved for the user.
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: '"Cascadia Code", "Fira Code", ui-monospace, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        scrollback: 5000,
        allowProposedApi: true,
        theme: {
          background: "#09090b",
          foreground: "#e4e4e7",
          cursor: "#a1a1aa",
          selectionBackground: "#3f3f4680",
          black: "#18181b",
          red: "#f87171",
          green: "#4ade80",
          yellow: "#fde047",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#d4d4d8",
          brightBlack: "#52525b",
          brightRed: "#fca5a5",
          brightGreen: "#86efac",
          brightYellow: "#fef08a",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#fafafa",
        },
      });
      termRef.current = term;

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);

      await new Promise<void>((r) => setTimeout(r, 16));
      if (!cancelled) fit.fit();

      colsRef.current = term.cols;
      rowsRef.current = term.rows;

      // Forward typed input to the active WS connection.
      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Propagate resize to both local tracking refs and the WS server.
      term.onResize(({ cols, rows }) => {
        colsRef.current = cols;
        rowsRef.current = rows;
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      // Re-fit when the container element resizes.
      const observer = new ResizeObserver(() => { if (!cancelled) fit.fit(); });
      observer.observe(containerRef.current!);

      // ── connect() opens a fresh WebSocket without touching the Terminal.
      //    It is called again on every reconnect attempt.
      function connect() {
        if (!mountedRef.current) return;

        let receivedIntentionalClose = false;

        const wsQuery = agentId
          ? `agentId=${encodeURIComponent(agentId)}`
          : `serverId=${encodeURIComponent(serverId ?? "")}`;
        const ws = new WebSocket(`${WS_URL}?${wsQuery}`);
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "resize", cols: colsRef.current, rows: rowsRef.current }));
        };

        ws.onmessage = (ev) => {
          if (!mountedRef.current) return;
          try {
            const msg = JSON.parse(ev.data as string) as {
              type: string;
              data?: string;
              message?: string;
            };

            if (msg.type === "connected") {
              // Successful handshake — reset backoff counter.
              attemptRef.current = 0;
              if (mountedRef.current) { setReconnectAttempt(0); setConnState("connected"); }
            } else if (msg.type === "output" && msg.data) {
              const binary = atob(msg.data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              term.write(bytes);
            } else if (msg.type === "disconnected") {
              // Intentional end (SSH session closed, timeout, etc.) — don't reconnect.
              receivedIntentionalClose = true;
              if (mountedRef.current) setConnState("disconnected");
              term.write("\r\n\x1b[33mSession ended.\x1b[0m  Close this tab to exit.\r\n");
            } else if (msg.type === "error") {
              // Application-level error from the WS server — don't reconnect.
              receivedIntentionalClose = true;
              if (mountedRef.current) { setConnState("error"); setErrorMsg(msg.message ?? "Unknown error"); }
              term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
            }
          } catch { /* ignore parse errors */ }
        };

        // onerror is always followed by onclose — handle backoff there.
        ws.onerror = () => { /* swallow — onclose fires next */ };

        ws.onclose = () => {
          if (!mountedRef.current || receivedIntentionalClose) return;

          const attempt = attemptRef.current;
          if (attempt >= MAX_ATTEMPTS) {
            if (mountedRef.current) {
              setConnState("error");
              setErrorMsg(
                `Unable to reconnect after ${MAX_ATTEMPTS} attempts. ` +
                "Check that the WebSocket server is running (npm run ws).",
              );
            }
            return;
          }

          const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
          attemptRef.current = attempt + 1;
          if (mountedRef.current) {
            setConnState("reconnecting");
            setReconnectAttempt(attempt + 1);
          }
          term.write(
            `\r\n\x1b[33mConnection lost — reconnecting in ${delay / 1000}s ` +
            `(attempt ${attempt + 1})…\x1b[0m\r\n`,
          );

          reconnectTimerRef.current = setTimeout(() => {
            if (mountedRef.current) connect();
          }, delay);
        };
      }

      connect();
    }

    init();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      termRef.current?.dispose();
      termRef.current = null;
      wsRef.current  = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, agentId]);

  return (
    <div className="relative h-full w-full bg-zinc-950 rounded-xl overflow-hidden">

      {/* ── Initial connection overlay (full-screen, blocking) ───────────── */}
      {connState === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-zinc-500 text-sm font-mono">Connecting to {label}…</p>
        </div>
      )}

      {/* ── Reconnecting badge — non-blocking so terminal remains usable ── */}
      {connState === "reconnecting" && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 px-3 py-1 text-xs font-mono text-amber-300">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Reconnecting… attempt {reconnectAttempt}
          </span>
        </div>
      )}

      {/* ── Permanent error overlay ──────────────────────────────────────── */}
      {connState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none">
          <p className="text-red-400 text-sm font-mono font-semibold">Connection failed</p>
          <p className="text-zinc-500 text-xs font-mono text-center max-w-sm px-4">{errorMsg}</p>
        </div>
      )}

      {/* xterm.js mounts into this div — always mounted so the terminal stays alive */}
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  );
}
