"use client";

import { useEffect, useState } from "react";
import { PageHeader, Btn } from "@/app/_components/ui";

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
  if (data.length === 0) return <p className="text-sm text-zinc-600 py-4">No data yet.</p>;

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
  if (data.length === 0) return <p className="text-sm text-zinc-600 py-4">No data yet.</p>;

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
        <span key={it.label} className="flex items-center gap-1.5 text-xs text-zinc-700">
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
    <div className="bg-white border border-zinc-200 rounded-xl p-4">
      <p className="text-xs text-zinc-600 font-medium">{label}</p>
      <p className={`text-2xl font-bold tracking-tight mt-1 ${color ?? "text-zinc-900"}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function AnalyticsPage() {
  const [weeks, setWeeks] = useState<WeeklyAnalytics[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [generating, setGenerating] = useState(false);

  function load() {
    fetch("/api/analytics/weekly")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setWeeks([...d].reverse()); });
    fetch("/api/analytics/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setSummary(d); });
  }

  useEffect(() => { load(); }, []);

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
          <Btn variant="secondary" disabled={generating} onClick={generateNow}>
            {generating ? "Computing…" : "Compute Prior Week"}
          </Btn>
        }
      />

      {summary && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide mb-3">
            Rolling 30-Day KPIs
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            <KpiCard
              label="Completed"
              value={summary.totalCompleted}
              color="text-green-700"
            />
            <KpiCard
              label="Completion Rate"
              value={summary.completionRate != null ? `${summary.completionRate}%` : "—"}
              sub="completed / (completed+failed)"
              color={
                summary.completionRate == null
                  ? "text-zinc-900"
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
              color="text-zinc-900"
            />
            <KpiCard
              label="p50 Duration"
              value={summary.p50ExecutionMinutes != null ? `${summary.p50ExecutionMinutes}m` : "—"}
              color="text-zinc-900"
            />
            <KpiCard
              label="p95 Duration"
              value={summary.p95ExecutionMinutes != null ? `${summary.p95ExecutionMinutes}m` : "—"}
              color="text-zinc-900"
            />
            <KpiCard
              label="Review Pass Rate"
              value={summary.reviewPassRate != null ? `${summary.reviewPassRate}%` : "—"}
              sub={`${summary.totalReviewsRun} reviews`}
              color={
                summary.reviewPassRate == null
                  ? "text-zinc-900"
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
        <section className="bg-white border border-zinc-200 rounded-xl p-5">
          <h2 className="font-semibold text-zinc-900 mb-1">Task Completion</h2>
          <p className="text-xs text-zinc-600 mb-4">Completed, failed, and created tasks per week</p>
          <BarChart data={weeks} bars={completionBars} height={180} />
          <Legend items={completionBars} />
        </section>

        <section className="bg-white border border-zinc-200 rounded-xl p-5">
          <h2 className="font-semibold text-zinc-900 mb-1">Failure Rate Trend</h2>
          <p className="text-xs text-zinc-600 mb-4">Failed tasks, timeouts, retries, and dispatch failures per week</p>
          <LineChart data={weeks} lines={failureLines} height={160} />
          <Legend items={failureLines} />
        </section>

        <section className="bg-white border border-zinc-200 rounded-xl p-5">
          <h2 className="font-semibold text-zinc-900 mb-1">Execution Duration Trend</h2>
          <p className="text-xs text-zinc-600 mb-4">Average, p50, and p95 execution time in minutes</p>
          <LineChart data={weeks} lines={durationLines} height={160} />
          <Legend items={durationLines} />
        </section>

        {weeks.length === 0 && (
          <div className="bg-white border border-zinc-200 rounded-xl p-10 text-center">
            <p className="text-sm text-zinc-700 font-medium mb-1">No weekly analytics yet</p>
            <p className="text-xs text-zinc-600">
              Analytics are computed automatically every Monday at 1 AM UTC, or click &ldquo;Compute Prior
              Week&rdquo; to generate now.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
