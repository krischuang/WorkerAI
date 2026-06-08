"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import { PageHeader, LoadingState } from "@/app/_components/ui";

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

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-5">
      <p className="text-sm text-zinc-700 font-medium">{label}</p>
      <p className={`text-3xl font-bold mt-1 tracking-tight ${color}`}>{value}</p>
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

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setData);
  }, []);

  if (!data) return <LoadingState message="Loading dashboard…" />;

  const { servers } = data;

  return (
    <div className="p-8 max-w-5xl">
      <PageHeader title="Dashboard" />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        <StatCard label="Active Projects" value={data.activeProjects} color="text-zinc-900" />
        <StatCard label="Pending" value={data.pendingTasks} color="text-zinc-700" />
        <StatCard label="Running" value={data.runningTasks} color="text-blue-700" />
        <StatCard label="Completed Today" value={data.completedToday} color="text-green-700" />
        <StatCard label="Failed" value={data.failedTasks} color="text-red-700" />
      </div>

      <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-zinc-900">Server Status</h2>
          <Link href="/servers" className="text-xs text-blue-700 hover:text-blue-900 font-medium transition-colors">
            Manage servers →
          </Link>
        </div>

        {servers.totalServers === 0 ? (
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-600">No servers configured.</p>
            <Link href="/servers/new" className="text-sm text-blue-700 hover:text-blue-900 font-medium transition-colors">
              Add AWS EC2 server →
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-6">
            <div className="text-center">
              <p className="text-2xl font-bold tracking-tight text-zinc-900">{servers.totalServers}</p>
              <p className="text-xs text-zinc-600 mt-0.5">Total</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold tracking-tight text-green-700">{servers.connectedServers}</p>
              <p className="text-xs text-zinc-600 mt-0.5">Connected</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold tracking-tight text-red-700">{servers.failedServers}</p>
              <p className="text-xs text-zinc-600 mt-0.5">Failed</p>
            </div>
            {servers.lastCheckedServer && (
              <div className="flex-1 ml-4 pl-4 border-l border-zinc-100">
                <p className="text-xs text-zinc-600 mb-1 font-medium">Last checked</p>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      SERVER_STATUS_DOT[servers.lastCheckedServer.status]
                    }`}
                    aria-hidden="true"
                  />
                  <Link
                    href={`/servers/${servers.lastCheckedServer.id}`}
                    className="text-sm font-medium text-zinc-800 hover:text-blue-700 transition-colors"
                  >
                    {servers.lastCheckedServer.name}
                  </Link>
                  <span className="text-xs text-zinc-600">
                    {new Date(servers.lastCheckedServer.lastCheckedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white rounded-xl border border-zinc-200 p-5">
          <h2 className="font-semibold text-zinc-900 mb-4">High Priority Pending</h2>
          {data.highPriorityPending.length === 0 ? (
            <p className="text-sm text-zinc-600">No high priority tasks.</p>
          ) : (
            <ul className="space-y-3">
              {data.highPriorityPending.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/tasks/${t.id}`}
                      className="text-sm font-medium text-zinc-900 hover:text-blue-700 truncate block transition-colors"
                    >
                      {t.title}
                    </Link>
                    <p className="text-xs text-zinc-600 mt-0.5">{t.project.name}</p>
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

        <section className="bg-white rounded-xl border border-zinc-200 p-5">
          <h2 className="font-semibold text-zinc-900 mb-4">Recently Completed</h2>
          {data.recentlyCompleted.length === 0 ? (
            <p className="text-sm text-zinc-600">Nothing completed today.</p>
          ) : (
            <ul className="space-y-3">
              {data.recentlyCompleted.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/tasks/${t.id}`}
                      className="text-sm font-medium text-zinc-900 hover:text-blue-700 truncate block transition-colors"
                    >
                      {t.title}
                    </Link>
                    <p className="text-xs text-zinc-600 mt-0.5">{t.project.name}</p>
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
