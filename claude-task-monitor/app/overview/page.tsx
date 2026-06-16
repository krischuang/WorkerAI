"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  LayoutGrid,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Bot,
} from "lucide-react";
import { PageHeader, LoadingState } from "@/app/_components/ui";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import type { ProjectOverview } from "@/app/api/overview/route";

function rowAlert(row: ProjectOverview): "red" | "amber" | null {
  if (row.taskCounts.failed > 0) return "red";
  if (row.oldestRunningTaskMinutes > 60) return "amber";
  return null;
}

function StatusDot({ alert }: { alert: "red" | "amber" | null }) {
  if (alert === "red")
    return (
      <span title="Has failed tasks">
        <XCircle className="w-4 h-4 text-red-500" />
      </span>
    );
  if (alert === "amber")
    return (
      <span title="Task running > 60 min">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
      </span>
    );
  return (
    <span title="All clear">
      <CheckCircle2 className="w-4 h-4 text-green-500" />
    </span>
  );
}

function durationLabel(minutes: number): string {
  if (minutes <= 0) return "—";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function OverviewPage() {
  const [rows, setRows]       = useState<ProjectOverview[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows(await res.json());
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const failCount  = rows?.filter((r) => r.taskCounts.failed > 0).length ?? 0;
  const stuckCount = rows?.filter((r) => r.oldestRunningTaskMinutes > 60).length ?? 0;

  return (
    <div className="p-8 max-w-5xl">
      <PageHeader
        title="Project Overview"
        action={
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {/* ── Summary pills ───────────────────────────────────────────────────── */}
      {rows && (
        <div className="flex flex-wrap gap-3 mb-6">
          <div className="flex items-center gap-1.5 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2">
            <LayoutGrid className="w-4 h-4 text-zinc-500" />
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{rows.length}</span>
            <span className="text-zinc-600 dark:text-zinc-400">projects</span>
          </div>
          {failCount > 0 && (
            <div className="flex items-center gap-1.5 text-sm bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
              <XCircle className="w-4 h-4 text-red-500" />
              <span className="font-medium text-red-700 dark:text-red-400">{failCount}</span>
              <span className="text-red-600 dark:text-red-500">
                {failCount === 1 ? "project with failures" : "projects with failures"}
              </span>
            </div>
          )}
          {stuckCount > 0 && (
            <div className="flex items-center gap-1.5 text-sm bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <span className="font-medium text-amber-700 dark:text-amber-400">{stuckCount}</span>
              <span className="text-amber-600 dark:text-amber-500">
                {stuckCount === 1 ? "project with stuck task" : "projects with stuck tasks"}
              </span>
            </div>
          )}
          {failCount === 0 && stuckCount === 0 && (
            <div className="flex items-center gap-1.5 text-sm bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2">
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              <span className="text-green-700 dark:text-green-400">All projects healthy</span>
            </div>
          )}
          {lastRefresh && (
            <div className="ml-auto flex items-center gap-1 text-xs text-zinc-400">
              <Clock className="w-3.5 h-3.5" />
              Updated {lastRefresh.toLocaleTimeString()}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !rows ? (
        <LoadingState message="Loading project overview…" />
      ) : rows && rows.length === 0 ? (
        <div className="text-sm text-zinc-600 dark:text-zinc-400 py-8 text-center">
          No active projects.{" "}
          <Link href="/projects" className="text-blue-700 hover:underline">
            Create one →
          </Link>
        </div>
      ) : rows ? (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950">
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 w-6" />
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Project</th>
                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Priority</th>
                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Pending</th>
                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Running</th>
                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Failed</th>
                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Longest Run</th>
                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  <span className="flex items-center justify-center gap-1"><Bot className="w-3.5 h-3.5" />Agents</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((row) => {
                const alert = rowAlert(row);
                return (
                  <tr
                    key={row.projectId}
                    className={`group transition-colors ${
                      alert === "red"
                        ? "bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-950/60"
                        : alert === "amber"
                        ? "bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    }`}
                  >
                    {/* Status icon */}
                    <td className="px-4 py-3">
                      <StatusDot alert={alert} />
                    </td>

                    {/* Project name + link */}
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${row.projectId}`}
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
                      >
                        {row.projectName}
                      </Link>
                      {row.projectStatus === "paused" && (
                        <span className="ml-2 text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded-full px-2 py-0.5">
                          paused
                        </span>
                      )}
                    </td>

                    {/* Priority */}
                    <td className="px-4 py-3 text-center">
                      <PriorityBadge priority={row.priority} />
                    </td>

                    {/* Pending */}
                    <td className="px-4 py-3 text-center">
                      <span className={`font-mono text-sm ${
                        row.taskCounts.pending > 0
                          ? "text-zinc-700 dark:text-zinc-300 font-semibold"
                          : "text-zinc-400"
                      }`}>
                        {row.taskCounts.pending || "—"}
                      </span>
                    </td>

                    {/* Running */}
                    <td className="px-4 py-3 text-center">
                      <span className={`font-mono text-sm ${
                        row.taskCounts.running > 0
                          ? "text-blue-700 dark:text-blue-400 font-semibold"
                          : "text-zinc-400"
                      }`}>
                        {row.taskCounts.running || "—"}
                      </span>
                    </td>

                    {/* Failed */}
                    <td className="px-4 py-3 text-center">
                      {row.taskCounts.failed > 0 ? (
                        <Link
                          href={`/tasks?projectId=${row.projectId}&status=failed`}
                          className="font-mono text-sm font-semibold text-red-600 hover:underline"
                        >
                          {row.taskCounts.failed}
                        </Link>
                      ) : (
                        <span className="font-mono text-sm text-zinc-400">—</span>
                      )}
                    </td>

                    {/* Longest running */}
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-mono ${
                        row.oldestRunningTaskMinutes > 60
                          ? "text-amber-600 dark:text-amber-400 font-semibold"
                          : row.oldestRunningTaskMinutes > 0
                          ? "text-zinc-600 dark:text-zinc-400"
                          : "text-zinc-400"
                      }`}>
                        {durationLabel(row.oldestRunningTaskMinutes)}
                      </span>
                    </td>

                    {/* Active agents */}
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-mono ${
                        row.activeAgents > 0
                          ? "text-violet-700 dark:text-violet-400 font-semibold"
                          : "text-zinc-400"
                      }`}>
                        {row.activeAgents || "—"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Legend */}
          <div className="border-t border-zinc-100 dark:border-zinc-800 px-4 py-2.5 flex items-center gap-4 text-xs text-zinc-500">
            <span className="flex items-center gap-1"><XCircle className="w-3.5 h-3.5 text-red-500" /> Failed tasks</span>
            <span className="flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> Task running &gt; 60 min</span>
            <span className="flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Healthy</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
