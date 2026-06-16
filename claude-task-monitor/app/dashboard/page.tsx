"use client";

import React, { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  FolderKanban,
  Clock,
  ArrowUpDown,
  Play,
  CheckCircle2,
  XCircle,
  Server,
  ChevronDown,
  ChevronRight,
  CalendarClock,
  AlertCircle,
} from "lucide-react";
import { nextCronDate } from "@/lib/cron-schedule";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import { PageHeader, LoadingState } from "@/app/_components/ui";
import type { TrendsResponse } from "@/app/api/dashboard/trends/route";

// Dynamically imported to avoid SSR issues with recharts DOM dependencies.
const ThroughputChart = dynamic(
  () => import("@/app/_components/ThroughputChart").then(m => ({ default: m.ThroughputChart })),
  { ssr: false, loading: () => <div className="h-[180px] bg-zinc-50 dark:bg-zinc-950 rounded animate-pulse" /> },
);
const ProjectSparklineRow = dynamic(
  () => import("@/app/_components/ThroughputChart").then(m => ({ default: m.ProjectSparklineRow })),
  { ssr: false },
);

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

interface QuotaReset {
  resourceType: "server" | "agent";
  resourceId: string;
  name: string;
  sessionPct: number | null;
  weekPct: number | null;
  sessionResetsAt: string | null;
  weekResetsAt: string | null;
  nearestResetsAt: string;
  pausedDueToUsage: boolean;
}

interface DashboardData {
  activeProjects: number;
  pendingTasks: number;
  stalePendingCount: number;
  queuedTasks: number;
  runningTasks: number;
  completedToday: number;
  failedTasks: number;
  servers: ServerSummary;
  quotaResets: QuotaReset[];
  upcomingScheduled: Array<{
    id: string;
    title: string;
    cronSchedule: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
    priority: string;
    project: { name: string };
    lastRunStatus: string | null;
    lastRunTaskId: string | null;
  }>;
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

function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60_000) return past ? "just now" : "< 1 min";
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(abs / 86_400_000);
  return past ? `${d}d ago` : `in ${d}d`;
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cronSummary(expr: string): string {
  const presets: Record<string, string> = {
    "* * * * *":   "every minute",
    "0 * * * *":   "every hour",
    "0 0 * * *":   "daily at 00:00",
    "0 3 * * *":   "daily at 03:00",
    "0 9 * * 1-5": "weekdays at 09:00",
    "0 1 * * 0":   "every Sunday 01:00",
    "0 8 * * 1":   "every Monday 08:00",
    "0 6 1 * *":   "monthly, day 1 at 06:00",
  };
  if (presets[expr.trim()]) return presets[expr.trim()];
  const p = expr.trim().split(/\s+/);
  if (p.length === 5) {
    const [min, hr, , , dow] = p;
    if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
      const t = `${hr.padStart(2,"0")}:${min.padStart(2,"0")}`;
      if (dow === "*") return `daily at ${t}`;
      if (dow === "1-5") return `weekdays at ${t}`;
      if (/^\d$/.test(dow)) return `every ${DOW_NAMES[+dow] ?? "?"} at ${t}`;
    }
  }
  return expr;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function QuotaResetsWidget({ entries }: { entries: QuotaReset[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  // Show up to 5 nearest
  const visible = entries.slice(0, 5);

  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 mb-6">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          Quota Resets
          {entries.some((e) => e.pausedDueToUsage) && (
            <span className="text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 rounded-full px-2 py-0.5">
              paused
            </span>
          )}
        </h2>
        {collapsed
          ? <ChevronRight className="w-4 h-4 text-zinc-400" />
          : <ChevronDown className="w-4 h-4 text-zinc-400" />}
      </button>

      {!collapsed && (
        <div className="mt-4 space-y-2">
          {visible.map((entry) => {
            const resetsMs = new Date(entry.nearestResetsAt).getTime() - now;
            const sessionPct = entry.sessionPct ?? 0;
            const weekPct = entry.weekPct ?? 0;
            const maxPct = Math.max(sessionPct, weekPct);
            const isPaused = entry.pausedDueToUsage;
            const isBlocked = maxPct >= 90;

            return (
              <div
                key={`${entry.resourceType}-${entry.resourceId}`}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 border text-sm ${
                  isPaused
                    ? "bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-700"
                    : "bg-zinc-50 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700"
                }`}
              >
                {/* Resource type badge */}
                <span className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 ${
                  entry.resourceType === "agent"
                    ? "bg-violet-100 text-violet-700"
                    : "bg-blue-100 text-blue-700"
                }`}>
                  {entry.resourceType}
                </span>

                {/* Name + link */}
                <Link
                  href={entry.resourceType === "agent"
                    ? `/agents/${entry.resourceId}`
                    : `/servers/${entry.resourceId}`}
                  className="flex-1 min-w-0 font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-700 truncate transition-colors"
                >
                  {entry.name}
                </Link>

                {/* Usage pct */}
                <span className={`text-xs font-mono shrink-0 ${isBlocked ? "text-red-600 font-semibold" : "text-zinc-500"}`}>
                  {maxPct}%
                </span>

                {/* Countdown */}
                <span className={`text-xs font-mono w-20 text-right shrink-0 ${
                  isPaused ? "text-amber-700 font-semibold" : "text-zinc-600 dark:text-zinc-400"
                }`}>
                  {formatCountdown(resetsMs)}
                </span>

                {isPaused && (
                  <span className="text-xs text-amber-700 dark:text-amber-400 shrink-0 font-medium">
                    paused
                  </span>
                )}
              </div>
            );
          })}
          {entries.length > 5 && (
            <p className="text-xs text-zinc-500 pt-1">
              +{entries.length - 5} more —{" "}
              <Link href="/servers" className="text-blue-700 hover:underline">view all servers</Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
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

function ScheduledRunStatusIcon({ status }: { status: string | null }) {
  if (!status) return null;
  let icon: React.ReactNode;
  switch (status) {
    case "completed": icon = <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />; break;
    case "failed":    icon = <XCircle      className="w-3.5 h-3.5 text-red-500" />; break;
    case "running":   icon = <Clock        className="w-3.5 h-3.5 text-blue-500 animate-pulse" />; break;
    default:          icon = <AlertCircle  className="w-3.5 h-3.5 text-amber-500" />; break;
  }
  return <span title={`Last run: ${status}`} className="shrink-0">{icon}</span>;
}

function getNext5(cronExpr: string): Date[] {
  const dates: Date[] = [];
  let after = new Date();
  for (let i = 0; i < 5; i++) {
    try {
      after = nextCronDate(cronExpr, after);
      dates.push(after);
    } catch {
      break;
    }
  }
  return dates;
}

function ScheduledTasksWidget({
  entries,
}: {
  entries: DashboardData["upcomingScheduled"];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (entries.length === 0) return null;
  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-blue-600" />
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Upcoming Scheduled Tasks</h2>
        </div>
        <Link
          href="/scheduled-tasks"
          className="text-xs text-blue-700 hover:text-blue-900 font-medium transition-colors"
        >
          Manage schedules →
        </Link>
      </div>
      <ul className="space-y-3">
        {entries.map((s) => (
          <li key={s.id}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <ScheduledRunStatusIcon status={s.lastRunStatus} />
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{s.title}</p>
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
                  {s.project.name} · <span className="font-mono">{s.cronSchedule}</span> · {cronSummary(s.cronSchedule)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-right">
                  {s.nextRunAt && (
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {relativeTime(s.nextRunAt)}
                    </p>
                  )}
                  {s.nextRunAt && (
                    <p className="text-xs text-zinc-500">
                      {new Date(s.nextRunAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                  title="Show upcoming runs"
                  className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 transition-colors"
                >
                  {expandedId === s.id
                    ? <ChevronDown className="w-3.5 h-3.5" />
                    : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {expandedId === s.id && (
              <div className="mt-2 ml-5 pl-3 border-l-2 border-zinc-100 dark:border-zinc-800 space-y-1">
                {getNext5(s.cronSchedule).map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                    <CalendarClock className="w-3 h-3 text-zinc-400 shrink-0" />
                    <span>{d.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                    <span className="text-zinc-400">({relativeTime(d.toISOString())})</span>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
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
  const [trends, setTrends] = useState<TrendsResponse | null>(null);

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
    fetch("/api/dashboard/trends")
      .then((r) => r.ok ? r.json() : null)
      .then((d: TrendsResponse | null) => { if (d) setTrends(d); })
      .catch(() => {});
  }, []);

  if (!data) return <LoadingState message="Loading dashboard…" />;

  const { servers } = data;

  return (
    <div className="p-8 max-w-5xl">
      <PageHeader title="Dashboard" />

      {/* Quota Resets — only shown when at least one resource has reset data */}
      {data.quotaResets.length > 0 && (
        <QuotaResetsWidget entries={data.quotaResets} />
      )}

      {/* Scheduled Tasks — only shown when there are active schedules */}
      {(data.upcomingScheduled?.length ?? 0) > 0 && (
        <ScheduledTasksWidget entries={data.upcomingScheduled} />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Projects" value={data.activeProjects} color="text-zinc-700 dark:text-zinc-300" icon={FolderKanban} iconBg="bg-zinc-100 dark:bg-zinc-800" />
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-zinc-100 dark:bg-zinc-800">
            <Clock className="w-5 h-5 text-zinc-600 dark:text-zinc-400" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide">Pending</p>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-2xl font-bold tracking-tight text-zinc-600 dark:text-zinc-400">{data.pendingTasks}</p>
              {(data.stalePendingCount ?? 0) > 0 && (
                <span
                  className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700 shrink-0"
                  title={`${data.stalePendingCount} task${data.stalePendingCount === 1 ? "" : "s"} waiting over 1 hour`}
                >
                  {data.stalePendingCount} stale
                </span>
              )}
            </div>
          </div>
        </div>
        <StatCard label="Queued" value={data.queuedTasks} color="text-violet-700" icon={ArrowUpDown} iconBg="bg-violet-50" />
        <StatCard label="Running" value={data.runningTasks} color="text-blue-700" icon={Play} iconBg="bg-blue-50" />
        <StatCard label="Completed Today" value={data.completedToday} color="text-green-700" icon={CheckCircle2} iconBg="bg-green-50" />
        <StatCard label="Failed" value={data.failedTasks} color="text-red-700" icon={XCircle} iconBg="bg-red-50" />
        <StatCard label="Servers Online" value={data.servers.connectedServers} color="text-green-700" icon={Server} iconBg="bg-green-50" />
      </div>

      {/* ── 7-day throughput chart ──────────────────────────────────────── */}
      {trends && (
        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 mb-6">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4">7-Day Throughput</h2>
          <ThroughputChart days={trends.days} />

          {trends.projectSparklines.length > 1 && (
            <>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mt-5 mb-3">
                Per-project (completed)
              </h3>
              <div className="space-y-2">
                {trends.projectSparklines.slice(0, 6).map(s => (
                  <ProjectSparklineRow key={s.projectId} sparkline={s} />
                ))}
              </div>
            </>
          )}

          <p className="text-xs text-zinc-400 mt-3 text-right">
            Cached · refreshes every 5 min
          </p>
        </section>
      )}

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
