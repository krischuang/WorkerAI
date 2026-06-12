"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader, LoadingState } from "@/app/_components/ui";

interface SlowQueryEntry {
  query:     string;
  duration:  number;
  timestamp: string;
}

interface HealthEntry {
  sshOk: boolean;
  tmuxOk: boolean;
  claudeOk: boolean;
  latencyMs: number | null;
  errorMessage: string | null;
  checkedAt: string;
}

interface ServerHealth {
  id: string;
  name: string;
  host: string;
  status: string;
  healthScore: number | null;
  consecutiveFailures: number;
  lastHealthCheckAt: string | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  workerHealths: HealthEntry[];
}

interface AgentHealth {
  id: string;
  name: string;
  slug: string;
  status: string;
  healthScore: number | null;
  consecutiveFailures: number;
  lastHealthCheckAt: string | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  server: { id: string; name: string; host: string };
  workerHealths: HealthEntry[];
}

interface DbPool {
  total: number;
  idle: number;
  waiting: number;
  utilisation: number;
}

interface PollerStatus {
  pollerAlive: boolean;
  lastHeartbeatAt: string | null;
  secondsSinceHeartbeat: number | null;
}

interface HealthData {
  servers: ServerHealth[];
  agents: AgentHealth[];
  dbPool?: DbPool;
  poller?: PollerStatus;
}

function scoreColor(score: number | null) {
  if (score === null) return "text-zinc-400";
  if (score >= 80) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function scoreBg(score: number | null) {
  if (score === null) return "bg-zinc-100 dark:bg-zinc-800";
  if (score >= 80) return "bg-emerald-500";
  if (score >= 50) return "bg-amber-400";
  return "bg-red-500";
}

function HealthBar({ score }: { score: number | null }) {
  const pct = score ?? 0;
  return (
    <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2 mt-1">
      <div
        className={`h-2 rounded-full transition-all ${scoreBg(score)}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function CheckDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
      ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      {label}
    </span>
  );
}

function DbPoolBar({ utilisation }: { utilisation: number }) {
  const pct = Math.round(utilisation * 100);
  const barColor =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-500";
  const textColor =
    pct >= 90 ? "text-red-600" : pct >= 70 ? "text-amber-600" : "text-emerald-600";
  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-zinc-500">Utilisation</span>
        <span className={`text-xs font-semibold tabular-nums ${textColor}`}>{pct}%</span>
      </div>
      <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function DiskBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const barColor = pct >= 95 ? "bg-red-500" : pct >= 80 ? "bg-amber-400" : "bg-blue-500";
  const textColor = pct >= 95 ? "text-red-600" : pct >= 80 ? "text-amber-600" : "text-zinc-600 dark:text-zinc-400";
  return (
    <div className="mt-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-zinc-500">Disk</span>
        <span className={`text-xs font-semibold tabular-nums ${textColor}`}>
          {formatBytes(used)} / {formatBytes(total)} ({pct}%)
        </span>
      </div>
      <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

function WorkerCard({
  name,
  subtitle,
  healthScore,
  consecutiveFailures,
  lastHealthCheckAt,
  latestCheck,
  diskUsedBytes,
  diskTotalBytes,
}: {
  name: string;
  subtitle: string;
  healthScore: number | null;
  consecutiveFailures: number;
  lastHealthCheckAt: string | null;
  latestCheck: HealthEntry | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="font-semibold text-zinc-900 dark:text-zinc-100">{name}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
        </div>
        <div className="text-right">
          <span className={`text-2xl font-bold tabular-nums ${scoreColor(healthScore)}`}>
            {healthScore ?? "—"}
          </span>
          <p className="text-xs text-zinc-400">/100</p>
        </div>
      </div>

      <HealthBar score={healthScore} />

      {latestCheck && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          <CheckDot ok={latestCheck.sshOk} label="SSH" />
          <CheckDot ok={latestCheck.tmuxOk} label="tmux" />
          <CheckDot ok={latestCheck.claudeOk} label="Claude" />
          {latestCheck.latencyMs !== null && (
            <span className="text-xs text-zinc-500 px-2 py-0.5">
              {latestCheck.latencyMs}ms
            </span>
          )}
        </div>
      )}

      {diskUsedBytes !== null && diskTotalBytes !== null && diskTotalBytes > 0 && (
        <DiskBar used={diskUsedBytes} total={diskTotalBytes} />
      )}

      {consecutiveFailures > 0 && (
        <p className="text-xs text-red-600 mt-2">
          {consecutiveFailures} consecutive failure{consecutiveFailures !== 1 ? "s" : ""}
        </p>
      )}

      {latestCheck?.errorMessage && (
        <p className="text-xs text-zinc-500 mt-2 truncate" title={latestCheck.errorMessage}>
          {latestCheck.errorMessage}
        </p>
      )}

      <p className="text-xs text-zinc-400 mt-2">
        {lastHealthCheckAt
          ? `Checked ${new Date(lastHealthCheckAt).toLocaleString()}`
          : "Never checked"}
      </p>
    </div>
  );
}

export default function HealthDashboard() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [slowQueries, setSlowQueries] = useState<SlowQueryEntry[]>([]);
  const slowQueriesIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSlowQueries = useCallback(() => {
    fetch("/api/admin/slow-queries")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: SlowQueryEntry[]) => setSlowQueries(d))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: HealthData) => {
        setData(d);
        setLoading(false);
        setRefreshing(false);
      })
      .catch(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    loadSlowQueries();
    slowQueriesIntervalRef.current = setInterval(loadSlowQueries, 30_000);
    return () => {
      if (slowQueriesIntervalRef.current) clearInterval(slowQueriesIntervalRef.current);
    };
  }, [loadSlowQueries]);

  function handleRefresh() {
    setRefreshing(true);
    load();
    loadSlowQueries();
  }

  if (loading) return <LoadingState />;

  const totalWorkers = (data?.servers.length ?? 0) + (data?.agents.length ?? 0);
  const healthyCount = [
    ...(data?.servers ?? []),
    ...(data?.agents ?? []),
  ].filter((w) => (w.healthScore ?? 0) >= 80).length;

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <PageHeader
          title="Health Monitor"
          subtitle={`${healthyCount}/${totalWorkers} workers healthy`}
        />
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 disabled:opacity-50 transition-colors"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: "Total Workers", value: totalWorkers },
          { label: "Healthy (≥80)", value: healthyCount, color: "text-emerald-600" },
          { label: "Degraded / Down", value: totalWorkers - healthyCount, color: "text-red-600" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 text-center">
            <p className={`text-3xl font-bold ${color ?? "text-zinc-900 dark:text-zinc-100"}`}>{value}</p>
            <p className="text-xs text-zinc-500 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Database Pool */}
      {data?.dbPool && (
        <section className="mb-8">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Database Pool</h2>
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 max-w-sm">
            <DbPoolBar utilisation={data.dbPool.utilisation} />
            <div className="flex gap-6 mt-3 text-xs text-zinc-600">
              <span>Total: <span className="font-semibold text-zinc-900 dark:text-zinc-100">{data.dbPool.total}</span></span>
              <span>Idle: <span className="font-semibold text-zinc-900 dark:text-zinc-100">{data.dbPool.idle}</span></span>
              <span>Waiting: <span className="font-semibold text-zinc-900 dark:text-zinc-100">{data.dbPool.waiting}</span></span>
            </div>
          </div>
        </section>
      )}

      {/* Poller */}
      {data?.poller && (
        <section className="mb-8">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Background Poller</h2>
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 max-w-sm">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-700 dark:text-zinc-300 font-medium">Status</span>
              <span
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  data.poller.pollerAlive
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                }`}
              >
                {data.poller.pollerAlive ? "Running" : "Stalled / Down"}
              </span>
            </div>
            <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400 space-y-1">
              <div className="flex justify-between">
                <span>Last heartbeat</span>
                <span className="text-zinc-900 dark:text-zinc-100 font-medium tabular-nums">
                  {data.poller.lastHeartbeatAt
                    ? new Date(data.poller.lastHeartbeatAt).toLocaleString()
                    : "Never"}
                </span>
              </div>
              {data.poller.secondsSinceHeartbeat !== null && (
                <div className="flex justify-between">
                  <span>Age</span>
                  <span
                    className={`font-semibold tabular-nums ${
                      data.poller.secondsSinceHeartbeat > 180 ? "text-red-600" : "text-zinc-900 dark:text-zinc-100"
                    }`}
                  >
                    {data.poller.secondsSinceHeartbeat}s ago
                  </span>
                </div>
              )}
            </div>
            {!data.poller.pollerAlive && (
              <p className="mt-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded px-2 py-1.5">
                No heartbeat in the last 3 minutes — tasks may not be advancing. Restart the Next.js server.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Servers */}
      {(data?.servers.length ?? 0) > 0 && (
        <section className="mb-8">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Servers ({data!.servers.length})</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data!.servers.map((s) => (
              <WorkerCard
                key={s.id}
                name={s.name}
                subtitle={s.host}
                healthScore={s.healthScore}
                consecutiveFailures={s.consecutiveFailures}
                lastHealthCheckAt={s.lastHealthCheckAt}
                latestCheck={s.workerHealths[0] ?? null}
                diskUsedBytes={s.diskUsedBytes}
                diskTotalBytes={s.diskTotalBytes}
              />
            ))}
          </div>
        </section>
      )}

      {/* Agents */}
      {(data?.agents.length ?? 0) > 0 && (
        <section>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Agents ({data!.agents.length})</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data!.agents.map((a) => (
              <WorkerCard
                key={a.id}
                name={a.name}
                subtitle={`${a.server.name} — ${a.slug}`}
                healthScore={a.healthScore}
                consecutiveFailures={a.consecutiveFailures}
                lastHealthCheckAt={a.lastHealthCheckAt}
                latestCheck={a.workerHealths[0] ?? null}
                diskUsedBytes={a.diskUsedBytes}
                diskTotalBytes={a.diskTotalBytes}
              />
            ))}
          </div>
        </section>
      )}

      {totalWorkers === 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-12 text-center">
          <p className="text-zinc-600 dark:text-zinc-400">No servers or agents configured yet.</p>
        </div>
      )}

      {/* Slow Queries */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">
            Slow Queries
            <span className="ml-2 text-xs font-normal text-zinc-500">&gt;500 ms · top 10 · refreshes every 30 s</span>
          </h2>
          <button
            onClick={loadSlowQueries}
            className="text-xs text-blue-700 hover:text-blue-900 font-medium transition-colors"
          >
            Refresh now
          </button>
        </div>

        {slowQueries.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 px-5 py-6 text-sm text-zinc-500">
            No slow queries captured yet. Queries taking longer than 500 ms will appear here.
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide w-20">
                    Duration
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                    Query
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide w-40 hidden sm:table-cell">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {slowQueries.map((q, i) => {
                  const durationColor =
                    q.duration >= 2000 ? "text-red-600 font-semibold" :
                    q.duration >= 1000 ? "text-amber-600 font-semibold" :
                    "text-zinc-700 dark:text-zinc-300";
                  return (
                    <tr
                      key={i}
                      className="border-b border-zinc-50 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                    >
                      <td className={`px-4 py-2.5 tabular-nums text-xs ${durationColor}`}>
                        {q.duration} ms
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-zinc-700 dark:text-zinc-300 max-w-0 truncate">
                        <span title={q.query}>{q.query}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-400 hidden sm:table-cell tabular-nums">
                        {new Date(q.timestamp).toLocaleTimeString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
