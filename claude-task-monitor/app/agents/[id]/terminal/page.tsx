"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";

const InteractiveTerminal = dynamic(
  () => import("@/app/_components/InteractiveTerminal"),
  { ssr: false, loading: () => null }
);

interface AgentInfo {
  id: string;
  name: string;
  slug: string;
  tmuxSession: string;
  workDir: string;
  server: { id: string; name: string; host: string; username: string; port: number };
}

export default function AgentTerminalPage() {
  const params = useParams();
  const id = params.id as string;
  const [agent, setAgent] = useState<AgentInfo | null>(null);

  useEffect(() => {
    fetch(`/api/agents/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AgentInfo | null) => { if (data) setAgent(data); });
  }, [id]);

  const connectionLabel = agent
    ? `${agent.server.username}@${agent.server.host} [${agent.tmuxSession}]`
    : "…";

  return (
    <div className="flex flex-col" style={{ height: "100vh", overflow: "hidden" }}>
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <span className="w-3 h-3 rounded-full bg-red-500/70" />
        <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
        <span className="w-3 h-3 rounded-full bg-green-500/70" />

        <div className="flex items-center gap-2 flex-1 ml-1">
          {agent && (
            <span className="text-xs font-mono text-zinc-300 truncate">{connectionLabel}</span>
          )}
          {agent && (
            <span className="text-xs text-zinc-600">— {agent.name}</span>
          )}
        </div>

        <Link
          href={`/agents/${id}`}
          className="text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded font-mono transition-colors shrink-0"
        >
          ← back
        </Link>
      </div>

      <div className="flex-1 min-h-0 bg-zinc-950">
        <InteractiveTerminal
          agentId={id}
          label={agent?.name ?? connectionLabel}
        />
      </div>
    </div>
  );
}
