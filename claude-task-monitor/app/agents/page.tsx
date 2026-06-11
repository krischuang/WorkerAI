"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Btn, LoadingState, EmptyState } from "@/app/_components/ui";

type AgentStatus = "idle" | "running" | "offline" | "error";
type ClaudePermissionMode = "read_only" | "workspace_write" | "full_autonomous";

interface Agent {
  id: string;
  name: string;
  slug: string;
  workDir: string;
  tmuxSession: string;
  status: AgentStatus;
  claudePermissionMode: ClaudePermissionMode;
  claudeSessionPct: number | null;
  claudeSessionResetsAt: string | null;
  claudeWeekPct: number | null;
  claudeWeekResetsAt: string | null;
  claudeUsageFetchedAt: string | null;
  server: { id: string; name: string; host: string };
  _count: { tasks: number };
  pausedDueToUsage: boolean;
}

const STATUS_BADGE: Record<AgentStatus, string> = {
  idle:    "bg-green-50 text-green-700 border-green-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  offline: "bg-zinc-100 text-zinc-600 border-zinc-200",
  error:   "bg-red-50 text-red-700 border-red-200",
};

const PERMISSION_LABEL: Record<ClaudePermissionMode, string> = {
  read_only:       "Read Only",
  workspace_write: "Workspace Write",
  full_autonomous: "Full Autonomous",
};

function formatResetCountdown(isoString: string | null): string {
  if (!isoString) return "Reset unknown";
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return "Reset unknown";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${mins}m`;
  return `Resets in ${mins}m`;
}

function UsageBar({ pct, resetAt }: { pct: number | null; resetAt?: string | null }) {
  if (pct === null) return <span className="text-zinc-400 text-xs">—</span>;
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-green-500";
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <div className="w-20 h-1.5 bg-zinc-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
        <span className="text-xs text-zinc-600">{Math.round(pct)}%</span>
      </div>
      <span className="text-xs text-zinc-500">{formatResetCountdown(resetAt ?? null)}</span>
    </div>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => { setAgents(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Group by server
  const byServer = agents.reduce<Record<string, Agent[]>>((acc, a) => {
    const key = a.server.id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader
        title="Agents"
        subtitle="Claude CLI instances — each with its own auth and working directory"
        action={
          <Link href="/agents/new">
            <Btn variant="primary" size="sm">New Agent</Btn>
          </Link>
        }
      />

      {loading && <LoadingState />}

      {!loading && agents.length === 0 && (
        <EmptyState
          message="No agents yet — create one to run Claude CLI independently on a server."
          action={
            <Link href="/agents/new">
              <Btn variant="primary" size="sm">New Agent</Btn>
            </Link>
          }
        />
      )}

      {!loading && Object.entries(byServer).map(([, serverAgents]) => {
        const server = serverAgents[0].server;
        return (
          <div key={server.id} className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <Link href={`/servers/${server.id}`} className="text-sm font-semibold text-zinc-900 hover:underline">
                {server.name}
              </Link>
              <span className="text-xs text-zinc-500">{server.host}</span>
            </div>

            <div className="border border-zinc-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-200">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Agent</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Session</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Week</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Mode</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Tasks</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {serverAgents.map((agent) => (
                    <tr key={agent.id} className="hover:bg-zinc-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-zinc-900">{agent.name}</div>
                        <div className="text-xs text-zinc-500 font-mono">{agent.tmuxSession}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_BADGE[agent.status]}`}>
                            {agent.status}
                          </span>
                          {agent.pausedDueToUsage && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-amber-50 text-amber-700 border-amber-200">
                              ⏸ paused
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3"><UsageBar pct={agent.claudeSessionPct} resetAt={agent.claudeSessionResetsAt} /></td>
                      <td className="px-4 py-3"><UsageBar pct={agent.claudeWeekPct} resetAt={agent.claudeWeekResetsAt} /></td>
                      <td className="px-4 py-3 text-xs text-zinc-600">{PERMISSION_LABEL[agent.claudePermissionMode]}</td>
                      <td className="px-4 py-3 text-xs text-zinc-600">{agent._count.tasks}</td>
                      <td className="px-4 py-3">
                        <Link href={`/agents/${agent.id}`} className="text-xs text-blue-600 hover:underline">
                          Details
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
