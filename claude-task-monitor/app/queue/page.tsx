"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PageHeader, EmptyState } from "@/app/_components/ui";

interface QueueTask {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  taskType: string;
  estimatedCostLevel: string;
  createdAt: string;
  project: {
    id: string;
    name: string;
    priority: string;
    status: string;
  };
  server: {
    id: string;
    name: string;
    host: string;
  } | null;
}

type AgentStatus = "idle" | "running" | "offline" | "error";

interface QueueAgent {
  id: string;
  name: string;
  slug: string;
  status: AgentStatus;
  pausedDueToUsage: boolean;
  claudeSessionPct: number | null;
  claudeWeekPct: number | null;
  claudeSessionResetsAt: string | null;
  claudeWeekResetsAt: string | null;
  runningTaskCount: number;
  maxConcurrentTasks: number;
  tags: string[];
  server: { id: string; name: string; host: string };
}

const AGENT_STATUS_BADGE: Record<AgentStatus, string> = {
  idle:    "bg-green-50 text-green-700 border-green-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  offline: "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700",
  error:   "bg-red-50 text-red-700 border-red-200",
};

const AGENT_STATUS_ORDER: Record<AgentStatus, number> = { idle: 0, running: 1, error: 2, offline: 3 };

function agentUsagePct(agent: QueueAgent): number {
  return Math.max(agent.claudeSessionPct ?? 0, agent.claudeWeekPct ?? 0);
}

function UsageBar({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-zinc-400 text-xs">—</span>;
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-green-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="text-xs text-zinc-600 dark:text-zinc-400">{Math.round(pct)}%</span>
    </div>
  );
}

export default function QueuePage() {
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [agents, setAgents] = useState<QueueAgent[]>([]);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  function loadQueue() {
    fetch("/api/queue")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setTasks(data); });
    fetch("/api/agents")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: QueueAgent[] | null) => {
        if (!data) return;
        const sorted = [...data].sort((a, b) => {
          const statusDiff = AGENT_STATUS_ORDER[a.status] - AGENT_STATUS_ORDER[b.status];
          if (statusDiff !== 0) return statusDiff;
          // Within same status, sort by usage ascending (most capacity first)
          return agentUsagePct(a) - agentUsagePct(b);
        });
        setAgents(sorted);
      });
  }

  useEffect(() => {
    loadQueue();
  }, []);

  async function markRunning(id: string) {
    await fetch(`/api/tasks/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  async function runOnServer(id: string) {
    setRunning((prev) => ({ ...prev, [id]: true }));
    setErrors((prev) => { const n = { ...prev }; delete n[id]; return n; });
    try {
      const res = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [id]: data.error ?? "Failed to run" }));
        return;
      }
      if (data.blocked) {
        setErrors((prev) => ({ ...prev, [id]: "Usage limit reached — open task to see countdown" }));
        return;
      }
      // Success: task is now running, remove from queue
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch {
      setErrors((prev) => ({ ...prev, [id]: "Request failed" }));
    } finally {
      setRunning((prev) => { const n = { ...prev }; delete n[id]; return n; });
    }
  }

  const queuedTasks = tasks.filter((t) => t.status === "queued");
  const pendingTasks = tasks.filter((t) => t.status === "pending");

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader
        title="Priority Queue"
        subtitle="Tasks ready to run sorted by project priority → task priority → age"
        action={
          tasks.length > 0 ? (
            <span className="text-sm text-zinc-600 dark:text-zinc-400 font-medium">{tasks.length} waiting</span>
          ) : undefined
        }
      />

      <div className="space-y-8">
        {/* ── Agent Order Queue ── */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide mb-2">
            Agents ({agents.length})
          </h2>
          {agents.length === 0 ? (
            <EmptyState message="No agents configured." />
          ) : (
            <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-700">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400 w-8">#</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Agent</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Session</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Week</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Tasks</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {agents.map((agent, i) => (
                    <tr key={agent.id} className="bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                      <td className="px-4 py-3 text-zinc-500 font-mono text-xs text-center">{i + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{agent.name}</div>
                        <div className="text-xs text-zinc-500">{agent.server.name}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border w-fit ${AGENT_STATUS_BADGE[agent.status]}`}>
                            {agent.status}
                          </span>
                          {agent.pausedDueToUsage && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-amber-50 text-amber-700 border-amber-200 w-fit">
                              paused
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3"><UsageBar pct={agent.claudeSessionPct} /></td>
                      <td className="px-4 py-3"><UsageBar pct={agent.claudeWeekPct} /></td>
                      <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                        {agent.runningTaskCount}/{agent.maxConcurrentTasks} running
                      </td>
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
          )}
        </section>

        {/* ── Task Queue ── */}
        {tasks.length === 0 ? (
          <EmptyState message="No tasks in queue. Great work!" />
        ) : (
          <div className="space-y-6">
            {/* ── Queued (server assigned, ready to run) ── */}
            {queuedTasks.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide mb-2">
                  Ready to run ({queuedTasks.length})
                </h2>
                <div className="space-y-2">
                  {queuedTasks.map((t, i) => (
                    <div
                      key={t.id}
                      className="bg-white dark:bg-zinc-900 rounded-xl border border-violet-200 p-4 flex items-center gap-4"
                    >
                      <div className="text-zinc-500 font-mono text-sm w-6 text-center shrink-0 select-none">
                        {i + 1}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <PriorityBadge priority={t.project.priority} />
                        <PriorityBadge priority={t.priority} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <Link
                          href={`/tasks/${t.id}`}
                          className="font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                        >
                          {t.title}
                        </Link>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                          <Link
                            href={`/projects/${t.project.id}`}
                            className="hover:text-zinc-900 dark:text-zinc-100 transition-colors"
                          >
                            {t.project.name}
                          </Link>
                          <span>{t.taskType}</span>
                          {t.server && (
                            <span className="text-violet-700 font-medium">
                              {t.server.name}
                            </span>
                          )}
                        </div>
                        {errors[t.id] && (
                          <p className="text-xs text-red-600 mt-1">{errors[t.id]}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={t.status} />
                        <button
                          onClick={() => runOnServer(t.id)}
                          disabled={running[t.id]}
                          className="text-xs bg-violet-700 text-white px-3 py-1.5 rounded-lg hover:bg-violet-800 font-medium transition-colors disabled:opacity-50"
                        >
                          {running[t.id] ? "Sending…" : "Run on Server"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Pending (no server assigned yet) ── */}
            {pendingTasks.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide mb-2">
                  Pending — needs server ({pendingTasks.length})
                </h2>
                <div className="space-y-2">
                  {pendingTasks.map((t, i) => (
                    <div
                      key={t.id}
                      className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 flex items-center gap-4"
                    >
                      <div className="text-zinc-500 font-mono text-sm w-6 text-center shrink-0 select-none">
                        {i + 1}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <PriorityBadge priority={t.project.priority} />
                        <PriorityBadge priority={t.priority} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <Link
                          href={`/tasks/${t.id}`}
                          className="font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                        >
                          {t.title}
                        </Link>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                          <Link
                            href={`/projects/${t.project.id}`}
                            className="hover:text-zinc-900 dark:text-zinc-100 transition-colors"
                          >
                            {t.project.name}
                          </Link>
                          <span>{t.taskType}</span>
                          <span>cost: {t.estimatedCostLevel}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={t.status} />
                        <button
                          onClick={() => markRunning(t.id)}
                          className="shrink-0 text-xs bg-blue-700 text-white px-3 py-1.5 rounded-lg hover:bg-blue-800 font-medium transition-colors"
                        >
                          Start
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
