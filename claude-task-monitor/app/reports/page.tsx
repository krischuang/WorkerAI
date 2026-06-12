"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Btn } from "@/app/_components/ui";

type Tab = "daily" | "weekly" | "monthly";

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

interface WeeklyReport {
  id: string;
  weekStart: string;
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
  agentUtilisation: { name: string; count: number }[];
  topCompletedTasks: { title: string; project: string }[];
  generatedBy: string;
  reportText: string | null;
  createdAt: string;
}

interface MonthlyReport {
  id: string;
  monthStart: string;
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
  agentUtilisation: { name: string; count: number }[];
  topCompletedTasks: { title: string; project: string }[];
  generatedBy: string;
  reportText: string | null;
  createdAt: string;
}

const TABS: { type: Tab; label: string }[] = [
  { type: "daily",   label: "Daily"   },
  { type: "weekly",  label: "Weekly"  },
  { type: "monthly", label: "Monthly" },
];

const STAT_ROWS = (r: { completedCount: number; failedCount: number; timedOutCount: number; retriedCount: number; runningCount: number; pendingCount: number; queuedCount: number; avgExecutionMinutes: number | null }) => [
  { label: "Completed", value: r.completedCount,  color: "green"  },
  { label: "Failed",    value: r.failedCount,     color: "red"    },
  { label: "Timed Out", value: r.timedOutCount,   color: "amber"  },
  { label: "Retried",   value: r.retriedCount,    color: "sky"    },
  { label: "Running",   value: r.runningCount,    color: "blue"   },
  { label: "Pending",   value: r.pendingCount,    color: "zinc"   },
  { label: "Queued",    value: r.queuedCount,     color: "violet" },
  { label: "Avg Exec",  value: r.avgExecutionMinutes != null ? `${r.avgExecutionMinutes}m` : "—", color: "teal" },
] as const;

function AutoBadge({ selected }: { selected: boolean }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
      selected ? "bg-zinc-700 text-zinc-300" : "bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400"
    }`}>Auto</span>
  );
}

function AgentUtilisationBar({ utilisation }: { utilisation: { name: string; count: number }[] }) {
  if (!Array.isArray(utilisation) || utilisation.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Agent Utilisation</p>
      <div className="space-y-1.5">
        {utilisation.map((a) => {
          const max = utilisation[0]?.count ?? 1;
          const pct = Math.round((a.count / max) * 100);
          return (
            <div key={a.name} className="flex items-center gap-2 text-xs">
              <span className="w-28 truncate text-zinc-700 dark:text-zinc-300 font-medium">{a.name}</span>
              <div className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full bg-zinc-800 rounded-full" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-zinc-500 w-10 text-right">{a.count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DailyTab() {
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [selected, setSelected] = useState<DailyReport | null>(null);
  const [generating, setGenerating] = useState(false);

  const loadReports = useCallback(() => {
    fetch("/api/reports/daily")
      .then((r) => r.json())
      .then((data) => {
        setReports(data);
        setSelected((prev) => prev ?? (data.length > 0 ? data[0] : null));
      });
  }, []);

  useEffect(() => { loadReports(); }, [loadReports]);

  async function generateReport() {
    setGenerating(true);
    const res = await fetch("/api/reports/daily", { method: "POST" });
    const report = await res.json();
    setGenerating(false);
    setReports((prev) => [report, ...prev]);
    setSelected(report);
  }

  return (
    <>
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
          {STAT_ROWS(selected).map(({ label, value, color }) => (
            <div key={label} className={`bg-${color}-50 border border-${color}-200 rounded-xl p-4 text-center`}>
              <p className={`text-2xl font-bold tracking-tight text-${color}-700`}>{value}</p>
              <p className={`text-xs text-${color}-700 mt-0.5 font-medium`}>{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-4 gap-6">
        <div className="col-span-1">
          <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wide mb-3">History</p>
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
                    {new Date(r.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                  {r.generatedBy === "auto" && <AutoBadge selected={selected?.id === r.id} />}
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
                    <span className="text-xs bg-sky-50 text-sky-700 border border-sky-200 px-2 py-0.5 rounded-full font-medium">Auto</span>
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
    </>
  );
}

function WeeklyTab() {
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [selected, setSelected] = useState<WeeklyReport | null>(null);
  const [generating, setGenerating] = useState(false);

  const loadReports = useCallback(() => {
    fetch("/api/reports/weekly")
      .then((r) => r.json())
      .then((data: WeeklyReport[]) => {
        setReports(data);
        setSelected((prev) => prev ?? (data.length > 0 ? data[0] : null));
      });
  }, []);

  useEffect(() => { loadReports(); }, [loadReports]);

  async function generateReport() {
    setGenerating(true);
    const res = await fetch("/api/reports/weekly", { method: "POST" });
    const report = await res.json() as WeeklyReport;
    setGenerating(false);
    setReports((prev) => [report, ...prev]);
    setSelected(report);
  }

  function weekLabel(r: WeeklyReport) {
    const start = new Date(r.weekStart);
    const end = new Date(start.getTime() + 6 * 86_400_000);
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }

  return (
    <>
      <PageHeader
        title="Weekly Report"
        subtitle="7-day summaries auto-generated every Monday"
        action={
          <Btn variant="primary" disabled={generating} onClick={generateReport}>
            {generating ? "Generating…" : "Generate This Week"}
          </Btn>
        }
      />

      {selected && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          {STAT_ROWS(selected).map(({ label, value, color }) => (
            <div key={label} className={`bg-${color}-50 border border-${color}-200 rounded-xl p-4 text-center`}>
              <p className={`text-2xl font-bold tracking-tight text-${color}-700`}>{value}</p>
              <p className={`text-xs text-${color}-700 mt-0.5 font-medium`}>{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-4 gap-6">
        <div className="col-span-1">
          <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wide mb-3">History</p>
          <ul className="space-y-1">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelected(r)}
                  className={`w-full text-left text-xs px-3 py-2 rounded-lg transition-colors flex items-center gap-1.5 ${
                    selected?.id === r.id
                      ? "bg-zinc-900 text-white font-medium"
                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:bg-zinc-800"
                  }`}
                >
                  <span>{weekLabel(r)}</span>
                  {r.generatedBy === "auto" && <AutoBadge selected={selected?.id === r.id} />}
                </button>
              </li>
            ))}
            {reports.length === 0 && (
              <p className="text-xs text-zinc-500">No weekly reports yet.</p>
            )}
          </ul>
        </div>

        <div className="col-span-3">
          {selected?.reportText ? (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">{weekLabel(selected)}</h2>
                  {selected.generatedBy === "auto" && (
                    <span className="text-xs bg-sky-50 text-sky-700 border border-sky-200 px-2 py-0.5 rounded-full font-medium">Auto</span>
                  )}
                </div>
                <span className="text-xs text-zinc-500">
                  {selected.activeServerCount} server{selected.activeServerCount !== 1 ? "s" : ""} ·{" "}
                  {selected.activeAgentCount} agent{selected.activeAgentCount !== 1 ? "s" : ""}
                </span>
              </div>
              <pre className="text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap font-sans leading-relaxed">
                {selected.reportText}
              </pre>
              <AgentUtilisationBar utilisation={selected.agentUtilisation} />
            </div>
          ) : (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-10 text-center">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Click &ldquo;Generate This Week&rdquo; to create a report for the current week.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function MonthlyTab() {
  const [reports, setReports] = useState<MonthlyReport[]>([]);
  const [selected, setSelected] = useState<MonthlyReport | null>(null);
  const [generating, setGenerating] = useState(false);

  const loadReports = useCallback(() => {
    fetch("/api/reports/monthly")
      .then((r) => r.json())
      .then((data: MonthlyReport[]) => {
        setReports(data);
        setSelected((prev) => prev ?? (data.length > 0 ? data[0] : null));
      });
  }, []);

  useEffect(() => { loadReports(); }, [loadReports]);

  async function generateReport() {
    setGenerating(true);
    const res = await fetch("/api/reports/monthly", { method: "POST" });
    const report = await res.json() as MonthlyReport;
    setGenerating(false);
    setReports((prev) => [report, ...prev]);
    setSelected(report);
  }

  function monthLabel(r: MonthlyReport) {
    return new Date(r.monthStart).toLocaleDateString(undefined, { year: "numeric", month: "long" });
  }

  return (
    <>
      <PageHeader
        title="Monthly Report"
        subtitle="Month-long summaries auto-generated on the 1st"
        action={
          <Btn variant="primary" disabled={generating} onClick={generateReport}>
            {generating ? "Generating…" : "Generate This Month"}
          </Btn>
        }
      />

      {selected && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          {STAT_ROWS(selected).map(({ label, value, color }) => (
            <div key={label} className={`bg-${color}-50 border border-${color}-200 rounded-xl p-4 text-center`}>
              <p className={`text-2xl font-bold tracking-tight text-${color}-700`}>{value}</p>
              <p className={`text-xs text-${color}-700 mt-0.5 font-medium`}>{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-4 gap-6">
        <div className="col-span-1">
          <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wide mb-3">History</p>
          <ul className="space-y-1">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelected(r)}
                  className={`w-full text-left text-xs px-3 py-2 rounded-lg transition-colors flex items-center gap-1.5 ${
                    selected?.id === r.id
                      ? "bg-zinc-900 text-white font-medium"
                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:bg-zinc-800"
                  }`}
                >
                  <span>{monthLabel(r)}</span>
                  {r.generatedBy === "auto" && <AutoBadge selected={selected?.id === r.id} />}
                </button>
              </li>
            ))}
            {reports.length === 0 && (
              <p className="text-xs text-zinc-500">No monthly reports yet.</p>
            )}
          </ul>
        </div>

        <div className="col-span-3">
          {selected?.reportText ? (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">{monthLabel(selected)}</h2>
                  {selected.generatedBy === "auto" && (
                    <span className="text-xs bg-sky-50 text-sky-700 border border-sky-200 px-2 py-0.5 rounded-full font-medium">Auto</span>
                  )}
                </div>
                <span className="text-xs text-zinc-500">
                  {selected.activeServerCount} server{selected.activeServerCount !== 1 ? "s" : ""} ·{" "}
                  {selected.activeAgentCount} agent{selected.activeAgentCount !== 1 ? "s" : ""}
                </span>
              </div>
              <pre className="text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap font-sans leading-relaxed">
                {selected.reportText}
              </pre>
              <AgentUtilisationBar utilisation={selected.agentUtilisation} />
            </div>
          ) : (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-10 text-center">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Click &ldquo;Generate This Month&rdquo; to create a report for the current month.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("daily");

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg w-fit mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.type}
            onClick={() => setActiveTab(tab.type)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              activeTab === tab.type
                ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "daily"   && <DailyTab />}
      {activeTab === "weekly"  && <WeeklyTab />}
      {activeTab === "monthly" && <MonthlyTab />}
    </div>
  );
}
