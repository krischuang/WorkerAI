"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Btn } from "@/app/_components/ui";
import { ReportTabs } from "@/app/_components/ReportTabs";

interface DailyReport {
  id: string;
  date: string;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  pendingCount: number;
  queuedCount: number;
  retriedCount: number;
  timedOutCount: number;
  recoveryCount: number;
  avgExecutionMinutes: number | null;
  activeServerCount: number;
  activeAgentCount: number;
  generatedBy: string;
  reportText: string | null;
  topProjectName: string | null;
  createdAt: string;
}

export default function DailyReportPage() {
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [selected, setSelected] = useState<DailyReport | null>(null);
  const [generating, setGenerating] = useState(false);

  const loadReports = useCallback(() => {
    fetch("/api/reports/daily")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setReports(data);
        setSelected((prev) => prev ?? (data.length > 0 ? data[0] : null));
      });
  }, []);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  async function generateReport() {
    setGenerating(true);
    const res = await fetch("/api/reports/daily", { method: "POST" });
    const report = await res.json();
    setGenerating(false);
    setReports((prev) => [report, ...prev]);
    setSelected(report);
  }

  return (
    <div className="p-8 max-w-5xl">
      <ReportTabs active="daily" />
      <PageHeader
        title="Daily Report"
        action={
          <Btn variant="primary" disabled={generating} onClick={generateReport}>
            {generating ? "Generating…" : "Generate Today's Report"}
          </Btn>
        }
      />

      {selected && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-green-700">{selected.completedCount}</p>
            <p className="text-xs text-green-700 mt-0.5 font-medium">Completed</p>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-blue-700">{selected.runningCount}</p>
            <p className="text-xs text-blue-700 mt-0.5 font-medium">Running</p>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-red-700">{selected.failedCount}</p>
            <p className="text-xs text-red-700 mt-0.5 font-medium">Failed</p>
          </div>
          <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-zinc-700 dark:text-zinc-300">{selected.pendingCount}</p>
            <p className="text-xs text-zinc-700 dark:text-zinc-300 mt-0.5 font-medium">Pending</p>
          </div>
          <div className="bg-violet-50 border border-violet-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-violet-700">{selected.queuedCount}</p>
            <p className="text-xs text-violet-700 mt-0.5 font-medium">Queued</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-amber-700">{selected.timedOutCount}</p>
            <p className="text-xs text-amber-700 mt-0.5 font-medium">Timed Out</p>
          </div>
          <div className="bg-sky-50 border border-sky-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-sky-700">{selected.retriedCount}</p>
            <p className="text-xs text-sky-700 mt-0.5 font-medium">Retried</p>
          </div>
          <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold tracking-tight text-teal-700">
              {selected.avgExecutionMinutes != null ? `${selected.avgExecutionMinutes}m` : "—"}
            </p>
            <p className="text-xs text-teal-700 mt-0.5 font-medium">Avg Exec</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-6">
        <div className="col-span-1">
          <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wide mb-3">
            History
          </p>
          <ul className="space-y-1">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelected(r)}
                  className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors flex items-center gap-1.5 ${
                    selected?.id === r.id
                      ? "bg-zinc-900 text-white font-medium"
                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:bg-zinc-800"
                  }`}
                >
                  <span>
                    {new Date(r.date).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  {r.generatedBy === "auto" && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                        selected?.id === r.id
                          ? "bg-zinc-700 text-zinc-300"
                          : "bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400"
                      }`}
                    >
                      Auto
                    </span>
                  )}
                </button>
              </li>
            ))}
            {reports.length === 0 && (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">No reports yet.</p>
            )}
          </ul>
        </div>

        <div className="col-span-3">
          {selected?.reportText ? (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {new Date(selected.date).toDateString()}
                  </h2>
                  {selected.generatedBy === "auto" && (
                    <span className="text-xs bg-sky-50 text-sky-700 border border-sky-200 px-2 py-0.5 rounded-full font-medium">
                      Auto
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {selected.topProjectName && (
                    <span className="text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-1 rounded-full font-medium">
                      Top: {selected.topProjectName}
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">
                    {selected.activeServerCount} server{selected.activeServerCount !== 1 ? "s" : ""} ·{" "}
                    {selected.activeAgentCount} agent{selected.activeAgentCount !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>
              <pre className="text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap font-sans leading-relaxed">
                {selected.reportText}
              </pre>
            </div>
          ) : (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-10 text-center">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Click &ldquo;Generate Today&apos;s Report&rdquo; to create a report from current task data.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
