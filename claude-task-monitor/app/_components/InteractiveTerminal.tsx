"use client";

// xterm.css must be a static side-effect import so Turbopack/webpack can bundle it.
// This file is only ever loaded via next/dynamic with ssr:false, so the CSS won't
// be evaluated during server-side rendering.
import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, useState } from "react";

const WS_URL =
  typeof window !== "undefined"
    ? `ws://${window.location.hostname}:3099`
    : "ws://localhost:3099";

type ConnState = "connecting" | "connected" | "disconnected" | "error";

interface Props {
  serverId: string;
  serverLabel: string;
}

export default function InteractiveTerminal({ serverId, serverLabel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  // Keep refs for cleanup — state updates are async and can't be read in closures
  const wsRef = useRef<WebSocket | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;

    async function init() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (cancelled || !containerRef.current) return;

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

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);

      // Let the DOM settle before first fit
      await new Promise<void>((r) => setTimeout(r, 16));
      if (!cancelled) fit.fit();

      // Track current size so we can send on WS open
      let { cols, rows } = term;

      const ws = new WebSocket(`${WS_URL}?serverId=${encodeURIComponent(serverId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            data?: string;
            message?: string;
            reason?: string;
          };

          if (msg.type === "connected") {
            if (!cancelled) setConnState("connected");
          } else if (msg.type === "output" && msg.data) {
            // Decode base64-encoded binary terminal data
            const binary = atob(msg.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            term.write(bytes);
          } else if (msg.type === "disconnected") {
            if (!cancelled) setConnState("disconnected");
            term.write("\r\n\x1b[33mSession ended.\x1b[0m  Close this tab to exit.\r\n");
          } else if (msg.type === "error") {
            if (!cancelled) {
              setConnState("error");
              setErrorMsg(msg.message ?? "Unknown error");
            }
            term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        if (!cancelled) {
          setConnState("error");
          setErrorMsg("Cannot reach WebSocket server — is `npm run ws` running on port 3001?");
        }
      };

      ws.onclose = () => {
        if (!cancelled) setConnState((prev) => (prev === "connected" ? "disconnected" : prev));
      };

      // Forward typed input to the SSH shell
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Notify server when terminal is resized
      term.onResize(({ cols: c, rows: r }) => {
        cols = c;
        rows = r;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: c, rows: r }));
        }
      });

      // Re-fit when the container element resizes
      const observer = new ResizeObserver(() => {
        if (!cancelled) fit.fit();
      });
      observer.observe(containerRef.current!);

      disposeRef.current = () => {
        observer.disconnect();
        ws.close();
        term.dispose();
      };
    }

    init();

    return () => {
      cancelled = true;
      disposeRef.current?.();
    };
  }, [serverId]);

  return (
    <div className="relative h-full w-full bg-zinc-950 rounded-xl overflow-hidden">
      {/* Overlay shown until SSH shell is ready */}
      {connState === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-zinc-500 text-sm font-mono">Connecting to {serverLabel}…</p>
        </div>
      )}
      {connState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none">
          <p className="text-red-400 text-sm font-mono font-semibold">Connection failed</p>
          <p className="text-zinc-500 text-xs font-mono text-center max-w-sm px-4">{errorMsg}</p>
        </div>
      )}
      {/* xterm.js mounts into this div */}
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  );
}
