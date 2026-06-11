"use client";

import { useEffect, useState } from "react";
import { PageHeader, Btn } from "@/app/_components/ui";

interface CostEntry { id: string; name: string; cost: number; tokens: number; count: number; }
interface CostData {
  period: { days: number; since: string };
  total: number;
  totalTokens: number;
  byProject: CostEntry[];
  byAgent: CostEntry[];
  daily: { date: string; cost: number }[];
  recentExecutions: {
    id: string; taskId: string; taskTitle: string;
    projectName: string | null; agentName: string | null;
    actualCostUsd: number | null; tokenCount: number | null;
    finishedAt: string | null;
  }[];
}

interface WeeklyAnalytics {
  id: string;
  weekStart: string;
  weekEnd: string;
  tasksCompleted: number;
  tasksFailed: number;
  tasksRetried: number;
  tasksTimedOut: number;
  tasksCreated: number;
  reviewsRun: number;
  reviewsPassed: number;
  reviewsFailed: number;
  avgExecutionMinutes: number | null;
  p50ExecutionMinutes: number | null;
  p95ExecutionMinutes: number | null;
  workerRecoveries: number;
  dispatchFailures: number;
  createdAt: string;
}

interface Summary {
  totalCompleted: number;
  totalFailed: number;
  totalCreated: number;
  totalTimedOut: number;
  totalRetried: number;
  totalReviewsRun: number;
  totalReviewsPassed: number;
  totalReviewsFailed: number;
  totalWorkerRecoveries: number;
  totalDispatchFailures: number;
  avgExecutionMinutes: number | null;
  p50ExecutionMinutes: number | null;
  p95ExecutionMinutes: number | null;
  completionRate: number | null;
  reviewPassRate: number | null;
}

function weekLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function BarChart({
  data,
  bars,
  height = 160,
}: {
  data: WeeklyAnalytics[];
  bars: { key: keyof WeeklyAnalytics; color: string; label: string }[];
  height?: number;
}) {
  if (data.length === 0) return <p className="text-sm text-zinc-600 dark:text-zinc-400 py-4">No data yet.</p>;

  const maxVal = Math.max(
    1,
    ...data.flatMap((d) => bars.map((b) => Number(d[b.key]) || 0))
  );
  const barW = Math.max(8, Math.floor(560 / (data.length * bars.length + data.length)));
  const gap = Math.floor(barW * 0.3);
  const groupW = bars.length * barW + (bars.length - 1) * gap;
  const groupGap = 12;
  const totalW = data.length * (groupW + groupGap) + groupGap;
  const padTop = 12;
  const padBottom = 28;
  const chartH = height - padTop - padBottom;

  return (
    <svg
      viewBox={`0 0 ${totalW} ${height}`}
      className="w-full overflow-visible"
      style={{ height }}
      aria-hidden="true"
    >
      {/* Gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
        const y = padTop + chartH * (1 - frac);
        return (
          <line
            key={frac}
            x1={0}
            x2={totalW}
            y1={y}
            y2={y}
            stroke="#e4e4e7"
            strokeWidth={1}
          />
        );
      })}

      {data.map((d, gi) => {
        const gx = groupGap + gi * (groupW + groupGap);
        return (
          <g key={d.id}>
            {bars.map((b, bi) => {
              const val = Number(d[b.key]) || 0;
              const barH = Math.max(2, (val / maxVal) * chartH);
              const x = gx + bi * (barW + gap);
              const y = padTop + chartH - barH;
              return (
                <g key={b.key}>
                  <rect x={x} y={y} width={barW} height={barH} fill={b.color} rx={2} />
                  {val > 0 && barH > 14 && (
                    <text
                      x={x + barW / 2}
                      y={y + barH - 3}
                      textAnchor="middle"
                      fontSize={9}
                      fill="white"
                      fontWeight="600"
                    >
                      {val}
                    </text>
                  )}
                </g>
              );
            })}
            <text
              x={gx + groupW / 2}
              y={height - 6}
              textAnchor="middle"
              fontSize={9}
              fill="#71717a"
            >
              {weekLabel(d.weekStart)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LineChart({
  data,
  lines,
  height = 140,
}: {
  data: WeeklyAnalytics[];
  lines: { key: keyof WeeklyAnalytics; color: string; label: string }[];
  height?: number;
}) {
  if (data.length === 0) return <p className="text-sm text-zinc-600 dark:text-zinc-400 py-4">No data yet.</p>;

  const padTop = 12;
  const padBottom = 28;
  const padLeft = 40;
  const padRight = 10;
  const chartH = height - padTop - padBottom;
  const chartW = 560;

  const allVals = data.flatMap((d) =>
    lines.map((l) => (d[l.key] != null ? Number(d[l.key]) : null)).filter((v): v is number => v != null)
  );
  const maxVal = allVals.length > 0 ? Math.max(...allVals) : 1;
  const minVal = 0;
  const range = maxVal - minVal || 1;

  const xStep = data.length > 1 ? (chartW - padLeft - padRight) / (data.length - 1) : 0;

  function px(i: number) {
    return padLeft + i * xStep;
  }
  function py(v: number) {
    return padTop + chartH * (1 - (v - minVal) / range);
  }

  return (
    <svg
      viewBox={`0 0 ${chartW} ${height}`}
      className="w-full overflow-visible"
      style={{ height }}
      aria-hidden="true"
    >
      {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
        const y = padTop + chartH * (1 - frac);
        const label = Math.round(minVal + range * frac);
        return (
          <g key={frac}>
            <line x1={padLeft} x2={chartW - padRight} y1={y} y2={y} stroke="#e4e4e7" strokeWidth={1} />
            <text x={padLeft - 4} y={y + 4} textAnchor="end" fontSize={9} fill="#71717a">
              {label}
            </text>
          </g>
        );
      })}

      {lines.map((l) => {
        const pts = data
          .map((d, i) => {
            const v = d[l.key] != null ? Number(d[l.key]) : null;
            return v != null ? `${px(i)},${py(v)}` : null;
          })
          .filter(Boolean);
        if (pts.length < 2) return null;
        return (
          <polyline
            key={String(l.key)}
            points={pts.join(" ")}
            fill="none"
            stroke={l.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}

      {data.map((d, i) =>
        lines.map((l) => {
          const v = d[l.key] != null ? Number(d[l.key]) : null;
          if (v == null) return null;
          return (
            <circle key={`${i}-${String(l.key)}`} cx={px(i)} cy={py(v)} r={3} fill={l.color} />
          );
        })
      )}

      {data.map((d, i) => (
        <text key={d.id} x={px(i)} y={height - 6} textAnchor="middle" fontSize={9} fill="#71717a">
          {weekLabel(d.weekStart)}
        </text>
      ))}
    </svg>
  );
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-3 mt-2">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
          <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-4">
      <p className="text-xs text-zinc-600 dark:text-zinc-400 font-medium">{label}</p>
      <p className={`text-2xl font-bold tracking-tight mt-1 ${color ?? "text-zinc-900 dark:text-zinc-100"}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function fmt$(n: number) {
  if (n < 0.001) return "<$0.001";
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function CostTable({ rows, label }: { rows: CostEntry[]; label: string }) {
  if (rows.length === 0) return <p className="text-sm text-zinc-600 dark:text-zinc-400 py-2">No cost data yet.</p>;
  const max = rows[0].cost;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-zinc-500 uppercase border-b border-zinc-100 dark:border-zinc-800">
          <th className="text-left pb-2 font-medium">{label}</th>
          <th className="text-right pb-2 font-medium">Cost</th>
          <th className="text-right pb-2 font-medium">Tokens</th>
          <th className="text-right pb-2 font-medium">Runs</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-zinc-50 last:border-0">
            <td className="py-2 pr-4">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <span className="text-zinc-900 dark:text-zinc-100 font-medium">{r.name}</span>
                  <div className="mt-1 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden w-full">
                    <div
                      className="h-full bg-violet-500 rounded-full"
                      style={{ width: `${Math.round((r.cost / max) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            </td>
            <td className="py-2 text-right font-mono text-zinc-900 dark:text-zinc-100">{fmt$(r.cost)}</td>
            <td className="py-2 text-right text-zinc-600 dark:text-zinc-400">{fmtTokens(r.tokens)}</td>
            <td className="py-2 text-right text-zinc-600 dark:text-zinc-400">{r.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DailyCostChart({ daily }: { daily: { date: string; cost: number }[] }) {
  if (daily.length === 0) return <p className="text-sm text-zinc-600 dark:text-zinc-400 py-2">No data.</p>;
  const max = Math.max(...daily.map((d) => d.cost), 0.001);
  const h = 100;
  const padB = 22;
  const chartH = h - padB;
  const w = 560;
  const barW = Math.max(6, Math.floor(w / daily.length) - 4);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }} aria-hidden="true">
      {daily.map((d, i) => {
        const barH = Math.max(2, (d.cost / max) * chartH);
        const x = (i / daily.length) * w + 2;
        return (
          <g key={d.date}>
            <rect x={x} y={chartH - barH} width={barW} height={barH} fill="#7c3aed" rx={2} />
            {i % Math.ceil(daily.length / 8) === 0 && (
              <text x={x + barW / 2} y={h - 4} textAnchor="middle" fontSize={8} fill="#71717a">
                {d.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function AnalyticsPage() {
  const [weeks, setWeeks] = useState<WeeklyAnalytics[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [generating, setGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<"performance" | "cost">("performance");
  const [costDays, setCostDays] = useState(30);
  const [costData, setCostData] = useState<CostData | null>(null);

  function load() {
    fetch("/api/analytics/weekly")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setWeeks([...d].reverse()); });
    fetch("/api/analytics/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setSummary(d); });
  }

  function loadCost(days: number) {
    fetch(`/api/analytics/cost?days=${days}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setCostData(d); });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); loadCost(costDays); }, []);

  async function generateNow() {
    setGenerating(true);
    await fetch("/api/analytics/weekly", { method: "POST" });
    setGenerating(false);
    load();
  }

  const completionBars = [
    { key: "tasksCompleted" as keyof WeeklyAnalytics, color: "#16a34a", label: "Completed" },
    { key: "tasksFailed" as keyof WeeklyAnalytics, color: "#dc2626", label: "Failed" },
    { key: "tasksCreated" as keyof WeeklyAnalytics, color: "#7c3aed", label: "Created" },
  ];

  const failureLines = [
    { key: "tasksFailed" as keyof WeeklyAnalytics, color: "#dc2626", label: "Failed" },
    { key: "tasksTimedOut" as keyof WeeklyAnalytics, color: "#d97706", label: "Timed Out" },
    { key: "tasksRetried" as keyof WeeklyAnalytics, color: "#0891b2", label: "Retried" },
    { key: "dispatchFailures" as keyof WeeklyAnalytics, color: "#9f1239", label: "Dispatch Fails" },
  ];

  const durationLines = [
    { key: "avgExecutionMinutes" as keyof WeeklyAnalytics, color: "#2563eb", label: "Avg" },
    { key: "p50ExecutionMinutes" as keyof WeeklyAnalytics, color: "#16a34a", label: "p50" },
    { key: "p95ExecutionMinutes" as keyof WeeklyAnalytics, color: "#d97706", label: "p95" },
  ];

  return (
    <div className="p-8 max-w-5xl">
      <PageHeader
        title="Analytics"
        action={
          activeTab === "performance" ? (
            <Btn variant="secondary" disabled={generating} onClick={generateNow}>
              {generating ? "Computing…" : "Compute Prior Week"}
            </Btn>
          ) : undefined
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-zinc-200 dark:border-zinc-700">
        {(["performance", "cost"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:text-zinc-100"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "performance" && (
        <>
          {summary && (
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide mb-3">
                Rolling 30-Day KPIs
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
                <KpiCard label="Completed" value={summary.totalCompleted} color="text-green-700" />
                <KpiCard
                  label="Completion Rate"
                  value={summary.completionRate != null ? `${summary.completionRate}%` : "—"}
                  sub="completed / (completed+failed)"
                  color={
                    summary.completionRate == null
                      ? "text-zinc-900 dark:text-zinc-100"
                      : summary.completionRate >= 80
                      ? "text-green-700"
                      : summary.completionRate >= 60
                      ? "text-amber-700"
                      : "text-red-700"
                  }
                />
                <KpiCard label="Failed" value={summary.totalFailed} color="text-red-700" />
                <KpiCard label="Created" value={summary.totalCreated} color="text-violet-700" />
                <KpiCard label="Timed Out" value={summary.totalTimedOut} color="text-amber-700" />
                <KpiCard label="Retried" value={summary.totalRetried} color="text-sky-700" />
                <KpiCard
                  label="Avg Execution"
                  value={summary.avgExecutionMinutes != null ? `${summary.avgExecutionMinutes}m` : "—"}
                />
                <KpiCard
                  label="p50 Duration"
                  value={summary.p50ExecutionMinutes != null ? `${summary.p50ExecutionMinutes}m` : "—"}
                />
                <KpiCard
                  label="p95 Duration"
                  value={summary.p95ExecutionMinutes != null ? `${summary.p95ExecutionMinutes}m` : "—"}
                />
                <KpiCard
                  label="Review Pass Rate"
                  value={summary.reviewPassRate != null ? `${summary.reviewPassRate}%` : "—"}
                  sub={`${summary.totalReviewsRun} reviews`}
                  color={
                    summary.reviewPassRate == null
                      ? "text-zinc-900 dark:text-zinc-100"
                      : summary.reviewPassRate >= 80
                      ? "text-green-700"
                      : "text-amber-700"
                  }
                />
                <KpiCard label="Worker Recoveries" value={summary.totalWorkerRecoveries} color="text-teal-700" />
                <KpiCard label="Dispatch Failures" value={summary.totalDispatchFailures} color="text-rose-700" />
              </div>
            </section>
          )}

          <div className="space-y-6">
            <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Task Completion</h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-4">Completed, failed, and created tasks per week</p>
              <BarChart data={weeks} bars={completionBars} height={180} />
              <Legend items={completionBars} />
            </section>

            <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Failure Rate Trend</h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-4">Failed tasks, timeouts, retries, and dispatch failures per week</p>
              <LineChart data={weeks} lines={failureLines} height={160} />
              <Legend items={failureLines} />
            </section>

            <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Execution Duration Trend</h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-4">Average, p50, and p95 execution time in minutes</p>
              <LineChart data={weeks} lines={durationLines} height={160} />
              <Legend items={durationLines} />
            </section>

            {weeks.length === 0 && (
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-10 text-center">
                <p className="text-sm text-zinc-700 dark:text-zinc-300 font-medium mb-1">No weekly analytics yet</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Analytics are computed automatically every Monday at 1 AM UTC, or click &ldquo;Compute Prior
                  Week&rdquo; to generate now.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === "cost" && (
        <div className="space-y-6">
          {/* Period selector */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-600 dark:text-zinc-400">Period:</span>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => { setCostDays(d); loadCost(d); }}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                  costDays === d
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:bg-zinc-700"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>

          {/* KPIs */}
          {costData && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <KpiCard
                label={`Total Spend (${costDays}d)`}
                value={fmt$(costData.total)}
                color="text-violet-700"
              />
              <KpiCard
                label="Total Tokens"
                value={fmtTokens(costData.totalTokens)}
                color="text-zinc-900 dark:text-zinc-100"
              />
              <KpiCard
                label="Tracked Executions"
                value={costData.byProject.reduce((s, p) => s + p.count, 0)}
                sub="with cost data"
                color="text-zinc-900 dark:text-zinc-100"
              />
            </div>
          )}

          {/* Daily chart */}
          {costData && costData.daily.length > 0 && (
            <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Daily Spend</h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-4">Estimated USD cost per day (completed executions with token data)</p>
              <DailyCostChart daily={costData.daily} />
            </section>
          )}

          {/* By project + by agent side by side */}
          {costData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
                <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4">By Project</h2>
                <CostTable rows={costData.byProject} label="Project" />
              </section>
              <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
                <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4">By Agent</h2>
                <CostTable rows={costData.byAgent} label="Agent" />
              </section>
            </div>
          )}

          {/* Recent executions */}
          {costData && costData.recentExecutions.length > 0 && (
            <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Recent Executions</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-zinc-500 uppercase border-b border-zinc-100 dark:border-zinc-800">
                      <th className="text-left pb-2 font-medium">Task</th>
                      <th className="text-left pb-2 font-medium">Project</th>
                      <th className="text-right pb-2 font-medium">Cost</th>
                      <th className="text-right pb-2 font-medium">Tokens</th>
                      <th className="text-right pb-2 font-medium">Finished</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costData.recentExecutions.map((e) => (
                      <tr key={e.id} className="border-b border-zinc-50 last:border-0">
                        <td className="py-2 pr-3 text-zinc-900 dark:text-zinc-100 max-w-[200px] truncate" title={e.taskTitle}>
                          {e.taskTitle}
                        </td>
                        <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">{e.projectName ?? "—"}</td>
                        <td className="py-2 text-right font-mono text-zinc-900 dark:text-zinc-100">
                          {e.actualCostUsd != null ? fmt$(e.actualCostUsd) : "—"}
                        </td>
                        <td className="py-2 text-right text-zinc-600 dark:text-zinc-400">
                          {e.tokenCount != null ? fmtTokens(e.tokenCount) : "—"}
                        </td>
                        <td className="py-2 text-right text-zinc-500 text-xs">
                          {e.finishedAt
                            ? new Date(e.finishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {costData && costData.total === 0 && (
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-10 text-center">
              <p className="text-sm text-zinc-700 dark:text-zinc-300 font-medium mb-1">No cost data yet</p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Cost data is captured when tasks complete on agents that output token counts in their usage data.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
