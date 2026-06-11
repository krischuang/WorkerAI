"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader, LoadingState } from "@/app/_components/ui";

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
  server: { id: string; name: string; host: string };
  workerHealths: HealthEntry[];
}

interface HealthData {
  servers: ServerHealth[];
  agents: AgentHealth[];
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

function WorkerCard({
  name,
  subtitle,
  healthScore,
  consecutiveFailures,
  lastHealthCheckAt,
  latestCheck,
}: {
  name: string;
  subtitle: string;
  healthScore: number | null;
  consecutiveFailures: number;
  lastHealthCheckAt: string | null;
  latestCheck: HealthEntry | null;
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

  function handleRefresh() {
    setRefreshing(true);
    load();
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
    </div>
  );
}
