"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader, LoadingState, Btn } from "@/app/_components/ui";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentRef {
  id: string;
  name: string;
  slug: string;
}

interface IncidentRow {
  id: string;
  source: string;
  severity: "warning" | "error" | "critical";
  status: "open" | "investigating" | "resolved" | "closed";
  title: string;
  message: string;
  rawError?: string;
  affectedAgent?: AgentRef;
  createdAt: string;
  updatedAt: string;
  repairTasks: { id: string; status: string; riskLevel: string; title: string }[];
}

interface RepairAttempt {
  id: string;
  attemptNumber: number;
  executedBy?: string;
  logs?: string;
  validationOutput?: string;
  validationPassed?: boolean;
  changedFiles: string[];
  commitHash?: string;
  status: string;
  createdAt: string;
  completedAt?: string;
}

interface AuditLog {
  id: string;
  status: string;
  validationResult?: string;
  changedFiles: string[];
  commitHash?: string;
  pushStatus?: string;
  errorMessage?: string;
  createdAt: string;
}

interface RepairTaskRow {
  id: string;
  title: string;
  description: string;
  suggestedSteps: string[];
  status: string;
  riskLevel: string;
  assignedAgent?: AgentRef;
  createdAt: string;
  updatedAt: string;
  incident: {
    id: string;
    source: string;
    severity: string;
    status: string;
    title: string;
    createdAt: string;
  };
  repairAttempts: RepairAttempt[];
  auditLogs: AuditLog[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function severityColor(s: string) {
  if (s === "critical") return "bg-red-100 text-red-800";
  if (s === "error") return "bg-orange-100 text-orange-800";
  return "bg-amber-100 text-amber-800";
}

function incidentStatusColor(s: string) {
  if (s === "resolved" || s === "closed") return "bg-emerald-100 text-emerald-800";
  if (s === "investigating") return "bg-blue-100 text-blue-800";
  return "bg-zinc-100 text-zinc-700";
}

function repairStatusColor(s: string) {
  if (s === "fixed") return "bg-emerald-100 text-emerald-800";
  if (s === "failed_validation" || s === "failed") return "bg-red-100 text-red-800";
  if (s === "needs_human_review") return "bg-amber-100 text-amber-800";
  if (s === "in_progress") return "bg-blue-100 text-blue-800";
  if (s === "assigned") return "bg-violet-100 text-violet-800";
  return "bg-zinc-100 text-zinc-700";
}

function riskColor(r: string) {
  if (r === "high") return "bg-red-100 text-red-700";
  if (r === "medium") return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

function Chip({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Repair Task Card ─────────────────────────────────────────────────────────

function RepairTaskCard({
  task,
  onRetry,
  onApprove,
  retrying,
  approving,
}: {
  task: RepairTaskRow;
  onRetry: (id: string) => void;
  onApprove: (id: string) => void;
  retrying: boolean;
  approving: boolean;
}) {
  const latestAttempt = task.repairAttempts[0] ?? null;
  const latestAudit = task.auditLogs[0] ?? null;

  const canRetry = ["fixed", "failed_validation", "failed", "in_progress", "needs_human_review"].includes(task.status);
  const canApprove = task.status === "needs_human_review" || task.status === "failed_validation";

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3 justify-between">
        <div className="min-w-0">
          <p className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">{task.title}</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Incident: <span className="font-mono">{task.incident.source}</span> · {timeAgo(task.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Chip label={task.status.replace(/_/g, " ")} cls={repairStatusColor(task.status)} />
          <Chip label={task.riskLevel} cls={riskColor(task.riskLevel)} />
        </div>
      </div>

      {/* Suggested steps */}
      {task.suggestedSteps.length > 0 && (
        <ol className="list-decimal list-inside space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
          {task.suggestedSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}

      {/* Latest attempt */}
      {latestAttempt && (
        <div className="bg-zinc-50 dark:bg-zinc-800 rounded-lg p-3 space-y-1.5">
          <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
            Attempt #{latestAttempt.attemptNumber}
            {latestAttempt.completedAt && (
              <span className="font-normal text-zinc-500 ml-1">· {timeAgo(latestAttempt.completedAt)}</span>
            )}
          </p>
          {latestAttempt.validationOutput && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">{latestAttempt.validationOutput}</p>
          )}
          {latestAttempt.validationPassed !== null && latestAttempt.validationPassed !== undefined && (
            <Chip
              label={latestAttempt.validationPassed ? "Validation passed" : "Validation failed"}
              cls={latestAttempt.validationPassed ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}
            />
          )}
          {latestAttempt.commitHash && (
            <p className="text-xs font-mono text-zinc-500">
              commit: {latestAttempt.commitHash.slice(0, 8)}
            </p>
          )}
          {latestAttempt.logs && (
            <details className="mt-1">
              <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-700">Show logs</summary>
              <pre className="text-[10px] text-zinc-600 dark:text-zinc-400 mt-1 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {latestAttempt.logs}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Latest audit */}
      {latestAudit && (
        <div className="text-xs text-zinc-500 flex flex-wrap gap-3">
          <span>
            Audit: <span className="font-medium text-zinc-700 dark:text-zinc-300">{latestAudit.status.replace(/_/g, " ")}</span>
          </span>
          {latestAudit.pushStatus && latestAudit.pushStatus !== "not_applicable" && (
            <span>
              Push: <span className="font-medium text-zinc-700 dark:text-zinc-300">{latestAudit.pushStatus}</span>
            </span>
          )}
          {latestAudit.commitHash && (
            <span>
              Commit: <span className="font-mono">{latestAudit.commitHash.slice(0, 8)}</span>
            </span>
          )}
          {latestAudit.errorMessage && (
            <span className="text-red-600 dark:text-red-400">{latestAudit.errorMessage}</span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {canRetry && (
          <Btn
            size="sm"
            variant="secondary"
            onClick={() => onRetry(task.id)}
            disabled={retrying}
          >
            {retrying ? "Retrying…" : "Retry"}
          </Btn>
        )}
        {canApprove && (
          <Btn
            size="sm"
            variant="primary"
            onClick={() => onApprove(task.id)}
            disabled={approving}
          >
            {approving ? "Approving…" : "Approve & Queue"}
          </Btn>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SelfHealingPage() {
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [repairTasks, setRepairTasks] = useState<RepairTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"tasks" | "incidents">("tasks");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [incRes, taskRes] = await Promise.all([
      fetch("/api/self-healing/incidents").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/self-healing/repair-tasks").then((r) => (r.ok ? r.json() : [])),
    ]);
    setIncidents(incRes);
    setRepairTasks(taskRes);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleRetry(taskId: string) {
    setRetryingId(taskId);
    try {
      await fetch(`/api/self-healing/repair-tasks/${taskId}/retry`, { method: "POST" });
      await load();
    } finally {
      setRetryingId(null);
    }
  }

  async function handleApprove(taskId: string) {
    setApprovingId(taskId);
    try {
      await fetch(`/api/self-healing/repair-tasks/${taskId}/approve`, { method: "POST" });
      await load();
    } finally {
      setApprovingId(null);
    }
  }

  if (loading) return <LoadingState />;

  const openIncidents = incidents.filter((i) => i.status === "open" || i.status === "investigating");
  const resolvedIncidents = incidents.filter((i) => i.status === "resolved" || i.status === "closed");
  const activeTasks = repairTasks.filter((t) => !["fixed", "failed"].includes(t.status));
  const doneTasks = repairTasks.filter((t) => ["fixed", "failed"].includes(t.status));

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <PageHeader
          title="Self-Healing"
          subtitle={`${openIncidents.length} open incident${openIncidents.length !== 1 ? "s" : ""} · ${activeTasks.length} active repair task${activeTasks.length !== 1 ? "s" : ""}`}
        />
        <button
          onClick={load}
          className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Open Incidents", value: openIncidents.length, color: openIncidents.length > 0 ? "text-amber-600" : "text-emerald-600" },
          { label: "Resolved", value: resolvedIncidents.length, color: "text-emerald-600" },
          { label: "Active Repairs", value: activeTasks.length, color: activeTasks.length > 0 ? "text-blue-600" : "text-zinc-900 dark:text-zinc-100" },
          { label: "Needs Review", value: repairTasks.filter((t) => t.status === "needs_human_review").length, color: "text-amber-600" },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 text-center"
          >
            <p className={`text-3xl font-bold ${color}`}>{value}</p>
            <p className="text-xs text-zinc-500 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-zinc-200 dark:border-zinc-700">
        {(["tasks", "incidents"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            {tab === "tasks" ? "Repair Tasks" : "Incidents"}
          </button>
        ))}
      </div>

      {/* ── Repair Tasks Tab ─────────────────────────────────────────────── */}
      {activeTab === "tasks" && (
        <div className="space-y-8">
          {activeTasks.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wide">
                Active ({activeTasks.length})
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {activeTasks.map((t) => (
                  <RepairTaskCard
                    key={t.id}
                    task={t}
                    onRetry={handleRetry}
                    onApprove={handleApprove}
                    retrying={retryingId === t.id}
                    approving={approvingId === t.id}
                  />
                ))}
              </div>
            </section>
          )}

          {doneTasks.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-500 mb-3 uppercase tracking-wide">
                Completed ({doneTasks.length})
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {doneTasks.slice(0, 20).map((t) => (
                  <RepairTaskCard
                    key={t.id}
                    task={t}
                    onRetry={handleRetry}
                    onApprove={handleApprove}
                    retrying={retryingId === t.id}
                    approving={approvingId === t.id}
                  />
                ))}
              </div>
            </section>
          )}

          {repairTasks.length === 0 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-12 text-center">
              <p className="text-zinc-600 dark:text-zinc-400">No repair tasks yet. The self-healing monitor runs every 60 seconds.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Incidents Tab ─────────────────────────────────────────────────── */}
      {activeTab === "incidents" && (
        <div className="space-y-8">
          {openIncidents.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wide">
                Open / Investigating ({openIncidents.length})
              </h2>
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 dark:border-zinc-800">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Source</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Title</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Agent</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Severity</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Status</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openIncidents.map((inc) => (
                      <tr
                        key={inc.id}
                        className="border-b border-zinc-50 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{inc.source}</span>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300 max-w-xs truncate">
                          <span title={inc.message}>{inc.title}</span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-zinc-500">
                          {inc.affectedAgent?.name ?? "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          <Chip label={inc.severity} cls={severityColor(inc.severity)} />
                        </td>
                        <td className="px-4 py-2.5">
                          <Chip label={inc.status} cls={incidentStatusColor(inc.status)} />
                        </td>
                        <td className="px-4 py-2.5 text-xs text-zinc-400 tabular-nums">
                          {timeAgo(inc.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {resolvedIncidents.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-500 mb-3 uppercase tracking-wide">
                Resolved ({resolvedIncidents.length})
              </h2>
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 dark:border-zinc-800">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Source</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Title</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Agent</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedIncidents.slice(0, 30).map((inc) => (
                      <tr
                        key={inc.id}
                        className="border-b border-zinc-50 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-xs text-zinc-500">{inc.source}</span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-zinc-500 max-w-xs truncate">{inc.title}</td>
                        <td className="px-4 py-2.5 text-xs text-zinc-500">{inc.affectedAgent?.name ?? "—"}</td>
                        <td className="px-4 py-2.5 text-xs text-zinc-400 tabular-nums">{timeAgo(inc.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {incidents.length === 0 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-12 text-center">
              <p className="text-zinc-600 dark:text-zinc-400">No incidents detected yet. The monitor runs every 60 seconds.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
