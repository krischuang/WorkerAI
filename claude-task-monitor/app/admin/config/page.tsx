"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Btn, FormField, inputCls } from "@/app/_components/ui";

interface ArchivalStats {
  retentionDays: number;
  cutoff: string;
  eligibleCount: number;
  oldestUnarchivedAt: string | null;
}

const TASK_TYPE_LABELS: { key: string; label: string; hint: string }[] = [
  { key: "timeout_coding_minutes",      label: "Coding",      hint: "Default timeout for coding tasks (default: 120 min)" },
  { key: "timeout_research_minutes",    label: "Research",    hint: "Default timeout for research tasks (default: 60 min)" },
  { key: "timeout_writing_minutes",     label: "Writing",     hint: "Default timeout for writing tasks (default: 45 min)" },
  { key: "timeout_review_minutes",      label: "Review",      hint: "Default timeout for review tasks (default: 30 min)" },
  { key: "timeout_maintenance_minutes", label: "Maintenance", hint: "Default timeout for maintenance tasks (default: 90 min)" },
];

type TimeoutConfig = Record<string, string>;

export default function AdminConfigPage() {
  const [timeouts, setTimeouts] = useState<TimeoutConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Metrics token state
  const [metricsToken, setMetricsToken] = useState<string>("");
  const [metricsTokenInput, setMetricsTokenInput] = useState<string>("");
  const [savingMetrics, setSavingMetrics] = useState(false);
  const [savedMetrics, setSavedMetrics] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  // Storage / archival state
  const [retentionDays, setRetentionDays] = useState<string>("90");
  const [archivalStats, setArchivalStats] = useState<ArchivalStats | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);
  const [savedRetention, setSavedRetention] = useState(false);
  const [runningArchival, setRunningArchival] = useState(false);
  const [archivalResult, setArchivalResult] = useState<number | null>(null);
  const [archivalError, setArchivalError] = useState<string | null>(null);

  const loadArchivalStats = useCallback(() => {
    fetch("/api/admin/archival")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ArchivalStats | null) => {
        if (data) {
          setArchivalStats(data);
          setRetentionDays(String(data.retentionDays));
        }
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    fetch("/api/admin/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, string> | null) => {
        if (data) {
          const initial: TimeoutConfig = {};
          for (const { key } of TASK_TYPE_LABELS) {
            initial[key] = data[key] ?? "";
          }
          setTimeouts(initial);
          const tok = data["metrics_token"] ?? "";
          setMetricsToken(tok);
          setMetricsTokenInput(tok);
        }
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(); loadArchivalStats(); }, [load, loadArchivalStats]);

  async function handleSaveRetention() {
    const n = parseInt(retentionDays, 10);
    if (isNaN(n) || n < 1) {
      setArchivalError("Retention must be a positive integer");
      return;
    }
    setSavingRetention(true);
    setArchivalError(null);
    const res = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_log_retention_days: String(n) }),
    });
    setSavingRetention(false);
    if (res.ok) {
      setSavedRetention(true);
      setTimeout(() => setSavedRetention(false), 3000);
      loadArchivalStats();
    } else {
      const d = await res.json().catch(() => ({}));
      setArchivalError((d as { error?: string }).error ?? "Save failed");
    }
  }

  async function handleRunArchival() {
    setRunningArchival(true);
    setArchivalResult(null);
    setArchivalError(null);
    const res = await fetch("/api/admin/archival", { method: "POST" });
    setRunningArchival(false);
    if (res.ok) {
      const d: { archived: number } = await res.json();
      setArchivalResult(d.archived);
      loadArchivalStats();
    } else {
      setArchivalError("Archival run failed");
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const body: Record<string, string> = {};
    for (const { key } of TASK_TYPE_LABELS) {
      const raw = timeouts[key]?.trim();
      if (!raw) continue;
      const n = parseInt(raw, 10);
      if (isNaN(n) || n <= 0) {
        setError(`"${key}" must be a positive integer`);
        setSaving(false);
        return;
      }
      body[key] = String(n);
    }

    const res = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      const resp = await res.json().catch(() => ({}));
      setError(resp.error ?? "Save failed");
    }
  }

  function handleGenerateToken() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const token = Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
    setMetricsTokenInput(token);
  }

  async function handleSaveMetricsToken() {
    setSavingMetrics(true);
    setMetricsError(null);
    const res = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metrics_token: metricsTokenInput.trim() }),
    });
    setSavingMetrics(false);
    if (res.ok) {
      setMetricsToken(metricsTokenInput.trim());
      setSavedMetrics(true);
      setTimeout(() => setSavedMetrics(false), 3000);
    } else {
      const d = await res.json().catch(() => ({}));
      setMetricsError((d as { error?: string }).error ?? "Save failed");
    }
  }

  if (loading) {
    return (
      <main className="flex-1 p-8">
        <PageHeader title="System Config" subtitle="Task timeout defaults by task type" />
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-4">Loading…</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-8 max-w-2xl">
      <PageHeader
        title="System Config"
        subtitle="Configure default timeouts for each task type"
      />

      <div className="mt-8 space-y-6">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Task Timeouts</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-5">
            These values are used when a task has no explicit timeout and no server/agent default.
            Resolution order: task override → server/agent default → task-type default → global (120 min).
          </p>

          <div className="space-y-4">
            {TASK_TYPE_LABELS.map(({ key, label, hint }) => (
              <FormField key={key} label={`${label} (minutes)`} hint={hint}>
                <input
                  type="number"
                  min={1}
                  value={timeouts[key] ?? ""}
                  onChange={(e) => setTimeouts((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder="minutes"
                  className={`${inputCls} max-w-xs`}
                />
              </FormField>
            ))}
          </div>

          {error && (
            <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="mt-6">
            <Btn variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
            </Btn>
          </div>
        </div>

        <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5">
          <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2 uppercase tracking-wide">
            Timeout Resolution Chain
          </h3>
          <ol className="text-sm text-zinc-600 dark:text-zinc-400 space-y-1 list-decimal list-inside">
            <li>Task-level override (<code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">task.timeoutMinutes</code>)</li>
            <li>Server default (<code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">server.defaultTaskTimeoutMinutes</code>)</li>
            <li>Agent default (<code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">agent.defaultTaskTimeoutMinutes</code>)</li>
            <li>Task-type default <span className="font-medium text-zinc-700 dark:text-zinc-300">(configured above)</span></li>
            <li>Global fallback: <span className="font-medium">120 minutes</span></li>
          </ol>
        </div>

        {/* Storage / archival section */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Storage</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-5">
            Execution logs older than the retention period have their large fields (log text, pane
            capture) nulled out nightly to reduce storage. The rest of the log record is preserved.
          </p>

          <FormField
            label="Log retention (days)"
            hint="Logs with finishedAt older than this many days will be archived nightly (default: 90)"
          >
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                placeholder="90"
                className={`${inputCls} max-w-xs`}
              />
              <Btn variant="secondary" onClick={handleSaveRetention} disabled={savingRetention}>
                {savingRetention ? "Saving…" : savedRetention ? "Saved ✓" : "Save"}
              </Btn>
            </div>
          </FormField>

          {archivalStats && (
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="bg-zinc-50 dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Eligible for archival</p>
                <p className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {archivalStats.eligibleCount.toLocaleString()}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  logs older than {new Date(archivalStats.cutoff).toLocaleDateString()}
                </p>
              </div>
              <div className="bg-zinc-50 dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Oldest unarchived log</p>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {archivalStats.oldestUnarchivedAt
                    ? new Date(archivalStats.oldestUnarchivedAt).toLocaleDateString()
                    : "—"}
                </p>
              </div>
            </div>
          )}

          <div className="mt-5 flex items-center gap-3">
            <Btn variant="secondary" onClick={handleRunArchival} disabled={runningArchival}>
              {runningArchival ? "Archiving…" : "Run archival now"}
            </Btn>
            {archivalResult !== null && (
              <p className="text-sm text-green-700 font-medium">
                Done — {archivalResult} log{archivalResult !== 1 ? "s" : ""} archived
              </p>
            )}
          </div>

          {archivalError && (
            <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {archivalError}
            </p>
          )}
        </div>

        {/* Prometheus metrics token */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
            Prometheus Metrics
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-5">
            <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">GET /api/metrics</code>{" "}
            returns Prometheus exposition format for external monitoring stacks. Access is protected
            by a Bearer token. Leave blank to disable the endpoint.
          </p>

          <FormField
            label="Bearer token"
            hint="Sent as: Authorization: Bearer <token>. Generate a random token or paste your own."
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={metricsTokenInput}
                onChange={(e) => setMetricsTokenInput(e.target.value)}
                placeholder="Paste or generate a token…"
                className={`${inputCls} font-mono text-xs flex-1 max-w-md`}
              />
              <Btn variant="secondary" onClick={handleGenerateToken}>
                Generate
              </Btn>
              <Btn variant="primary" onClick={handleSaveMetricsToken} disabled={savingMetrics}>
                {savingMetrics ? "Saving…" : savedMetrics ? "Saved ✓" : "Save"}
              </Btn>
            </div>
          </FormField>

          {metricsError && (
            <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {metricsError}
            </p>
          )}

          {metricsToken && (
            <div className="mt-5 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 space-y-3">
              <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide">
                Scrape configuration
              </p>
              <div>
                <p className="text-xs text-zinc-500 mb-1">Prometheus scrape_configs entry</p>
                <pre className="text-xs font-mono bg-zinc-900 text-zinc-100 rounded p-3 overflow-x-auto whitespace-pre">
{`- job_name: workerai
  metrics_path: /api/metrics
  scheme: http
  authorization:
    credentials: ${metricsToken}
  static_configs:
    - targets: [<your-host>:3000]`}
                </pre>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-1">curl / test</p>
                <pre className="text-xs font-mono bg-zinc-900 text-zinc-100 rounded p-3 overflow-x-auto whitespace-pre">
{`curl -H "Authorization: Bearer ${metricsToken}" http://localhost:3000/api/metrics`}
                </pre>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-1 font-medium">Exposed gauges &amp; counters</p>
                <ul className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 list-disc list-inside font-mono">
                  <li>workerai_db_pool_total</li>
                  <li>workerai_db_pool_idle</li>
                  <li>workerai_db_pool_waiting</li>
                  <li>workerai_poller_last_heartbeat_seconds_ago</li>
                  <li>{"workerai_tasks_by_status{status=\"…\"}"}</li>
                  <li>workerai_active_agents</li>
                  <li>workerai_active_servers</li>
                  <li>workerai_webhook_delivery_failures_total</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
