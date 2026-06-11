"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  FolderKanban,
  Clock,
  ArrowUpDown,
  Play,
  CheckCircle2,
  XCircle,
  Server,
} from "lucide-react";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import { PageHeader, LoadingState } from "@/app/_components/ui";

interface TodayReport {
  id: string;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  queuedCount: number;
  timedOutCount: number;
  avgExecutionMinutes: number | null;
  activeServerCount: number;
  activeAgentCount: number;
  generatedBy: string;
  date: string;
}

interface ServerSummary {
  totalServers: number;
  connectedServers: number;
  failedServers: number;
  lastCheckedServer: {
    id: string;
    name: string;
    status: string;
    lastCheckedAt: string;
  } | null;
}

interface DashboardData {
  activeProjects: number;
  pendingTasks: number;
  queuedTasks: number;
  runningTasks: number;
  completedToday: number;
  failedTasks: number;
  servers: ServerSummary;
  highPriorityPending: Array<{
    id: string;
    title: string;
    priority: string;
    project: { name: string; priority: string };
  }>;
  recentlyCompleted: Array<{
    id: string;
    title: string;
    project: { name: string };
    updatedAt: string;
  }>;
}

function StatCard({
  label,
  value,
  color,
  icon: Icon,
  iconBg,
}: {
  label: string;
  value: number;
  color: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 flex items-center gap-4">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
        <Icon className={`w-5 h-5 ${color}`} />
      </div>
      <div>
        <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide">{label}</p>
        <p className={`text-2xl font-bold tracking-tight mt-0.5 ${color}`}>{value}</p>
      </div>
    </div>
  );
}

const SERVER_STATUS_DOT: Record<string, string> = {
  unknown: "bg-zinc-400",
  connected: "bg-green-500",
  failed: "bg-red-500",
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [todayReport, setTodayReport] = useState<TodayReport | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(setData)
      .catch(console.error);
    const today = new Date().toISOString().slice(0, 10);
    fetch(`/api/reports/daily/${today}`)
      .then((r) => { if (r.status === 404) return null; if (!r.ok) return null; return r.json(); })
      .then((d) => setTodayReport(d))
      .catch(() => setTodayReport(null));
  }, []);

  if (!data) return <LoadingState message="Loading dashboard…" />;

  const { servers } = data;

  return (
    <div className="p-8 max-w-5xl">
      <PageHeader title="Dashboard" />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Projects" value={data.activeProjects} color="text-zinc-700 dark:text-zinc-300" icon={FolderKanban} iconBg="bg-zinc-100 dark:bg-zinc-800" />
        <StatCard label="Pending" value={data.pendingTasks} color="text-zinc-600 dark:text-zinc-400" icon={Clock} iconBg="bg-zinc-100 dark:bg-zinc-800" />
        <StatCard label="Queued" value={data.queuedTasks} color="text-violet-700" icon={ArrowUpDown} iconBg="bg-violet-50" />
        <StatCard label="Running" value={data.runningTasks} color="text-blue-700" icon={Play} iconBg="bg-blue-50" />
        <StatCard label="Completed Today" value={data.completedToday} color="text-green-700" icon={CheckCircle2} iconBg="bg-green-50" />
        <StatCard label="Failed" value={data.failedTasks} color="text-red-700" icon={XCircle} iconBg="bg-red-50" />
        <StatCard label="Servers Online" value={data.servers.connectedServers} color="text-green-700" icon={Server} iconBg="bg-green-50" />
      </div>

      {todayReport !== undefined && (
        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Today&apos;s Report</h2>
              {todayReport?.generatedBy === "auto" && (
                <span className="text-xs bg-sky-50 text-sky-700 border border-sky-200 px-2 py-0.5 rounded-full font-medium">
                  Auto
                </span>
              )}
            </div>
            <Link href="/reports/daily" className="text-xs text-blue-700 hover:text-blue-900 font-medium transition-colors">
              Full report →
            </Link>
          </div>
          {todayReport ? (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              <div className="text-center">
                <p className="text-xl font-bold text-green-700">{todayReport.completedCount}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Completed</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold text-red-700">{todayReport.failedCount}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Failed</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold text-blue-700">{todayReport.runningCount}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Running</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold text-violet-700">{todayReport.queuedCount}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Queued</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold text-amber-700">{todayReport.timedOutCount}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Timed Out</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold text-teal-700">
                  {todayReport.avgExecutionMinutes != null ? `${todayReport.avgExecutionMinutes}m` : "—"}
                </p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Avg Exec</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No report for today yet.{" "}
              <Link href="/reports/daily" className="text-blue-700 hover:underline">
                Generate one →
              </Link>
            </p>
          )}
        </section>
      )}

      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Server Status</h2>
          <Link href="/servers" className="text-xs text-blue-700 hover:text-blue-900 font-medium transition-colors">
            Manage servers →
          </Link>
        </div>

        {servers.totalServers === 0 ? (
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No servers configured.</p>
            <Link href="/servers/new" className="text-sm text-blue-700 hover:text-blue-900 font-medium transition-colors">
              Add AWS EC2 server →
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-6">
            <div className="text-center">
              <p className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{servers.totalServers}</p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Total</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold tracking-tight text-green-700">{servers.connectedServers}</p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Connected</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold tracking-tight text-red-700">{servers.failedServers}</p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Failed</p>
            </div>
            {servers.lastCheckedServer && (
              <div className="flex-1 ml-4 pl-4 border-l border-zinc-100 dark:border-zinc-800">
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-1 font-medium">Last checked</p>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      SERVER_STATUS_DOT[servers.lastCheckedServer.status]
                    }`}
                    aria-hidden="true"
                  />
                  <Link
                    href={`/servers/${servers.lastCheckedServer.id}`}
                    className="text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-700 transition-colors"
                  >
                    {servers.lastCheckedServer.name}
                  </Link>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    {new Date(servers.lastCheckedServer.lastCheckedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4">High Priority Pending</h2>
          {data.highPriorityPending.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No high priority tasks.</p>
          ) : (
            <ul className="space-y-3">
              {data.highPriorityPending.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/tasks/${t.id}`}
                      className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                    >
                      {t.title}
                    </Link>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">{t.project.name}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <PriorityBadge priority={t.project.priority} />
                    <PriorityBadge priority={t.priority} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Recently Completed</h2>
          {data.recentlyCompleted.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Nothing completed today.</p>
          ) : (
            <ul className="space-y-3">
              {data.recentlyCompleted.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/tasks/${t.id}`}
                      className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                    >
                      {t.title}
                    </Link>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">{t.project.name}</p>
                  </div>
                  <StatusBadge status="completed" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
