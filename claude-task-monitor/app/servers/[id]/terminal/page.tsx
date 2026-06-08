"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";

// Load xterm.js only on the client — it uses browser canvas APIs
const InteractiveTerminal = dynamic(
  () => import("@/app/_components/InteractiveTerminal"),
  { ssr: false, loading: () => null }
);

interface ServerInfo {
  id: string;
  name: string;
  username: string;
  host: string;
  port: number;
}

export default function TerminalPage() {
  const params = useParams();
  const id = params.id as string;
  const [server, setServer] = useState<ServerInfo | null>(null);

  useEffect(() => {
    fetch(`/api/servers/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ServerInfo | null) => { if (data) setServer(data); });
  }, [id]);

  const serverLabel = server
    ? `${server.username}@${server.host}:${server.port}`
    : "…";

  return (
    // Full-viewport flex column — terminal fills remaining space after header bar
    <div className="flex flex-col" style={{ height: "100vh", overflow: "hidden" }}>
      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-900 border-b border-zinc-800 shrink-0">
        {/* macOS-style traffic lights */}
        <span className="w-3 h-3 rounded-full bg-red-500/70" />
        <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
        <span className="w-3 h-3 rounded-full bg-green-500/70" />

        <div className="flex items-center gap-2 flex-1 ml-1">
          {server && (
            <span className="text-xs font-mono text-zinc-300 truncate">{serverLabel}</span>
          )}
          {server && (
            <span className="text-xs text-zinc-600">— {server.name}</span>
          )}
        </div>

        <Link
          href={`/servers/${id}`}
          className="text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded font-mono transition-colors shrink-0"
        >
          ← back
        </Link>
      </div>

      {/* ── Terminal ── */}
      <div className="flex-1 min-h-0 bg-zinc-950">
        <InteractiveTerminal
          serverId={id}
          serverLabel={server?.name ?? serverLabel}
        />
      </div>
    </div>
  );
}
