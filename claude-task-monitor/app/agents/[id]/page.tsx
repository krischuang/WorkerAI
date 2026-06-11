"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  PageHeader, BackLink, Btn, FormField, inputCls, Modal, ModalActions,
} from "@/app/_components/ui";

type AgentStatus = "idle" | "running" | "offline" | "error";
type ClaudePermissionMode = "read_only" | "workspace_write" | "full_autonomous";

interface AgentTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  project: { id: string; name: string };
}

interface Agent {
  id: string;
  name: string;
  slug: string;
  workDir: string;
  tmuxSession: string;
  status: AgentStatus;
  claudePermissionMode: ClaudePermissionMode;
  claudeSessionPct: number | null;
  claudeSessionResets: string | null;
  claudeSessionResetsAt: string | null;
  claudeWeekPct: number | null;
  claudeWeekResets: string | null;
  claudeWeekResetsAt: string | null;
  claudeUsageRaw: string | null;
  claudeUsageFetchedAt: string | null;
  claudeUsageCreditsEnabled: boolean | null;
  claudeLastRefreshStatus: string | null;
  createdAt: string;
  updatedAt: string;
  server: { id: string; name: string; host: string; username: string; port: number };
  _count: { tasks: number };
  pausedDueToUsage: boolean;
  pausedAt: string | null;
  autoPauseEnabled: boolean;
}

type UsageDisplayStatus = "live" | "stale" | "rate_limited" | "unknown";

function computeDisplayStatus(
  fetchedAt: string | null,
  lastRefreshStatus: string | null,
): UsageDisplayStatus {
  if (!fetchedAt) return "unknown";
  if (lastRefreshStatus === "rate_limited") return "rate_limited";
  if (lastRefreshStatus !== "ok") return "unknown";
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return ageMs < 10 * 60 * 1000 ? "live" : "stale";
}

const DISPLAY_STATUS_STYLE: Record<UsageDisplayStatus, { label: string; cls: string }> = {
  live:         { label: "Live",         cls: "bg-green-50 text-green-700 border-green-200" },
  stale:        { label: "Stale",        cls: "bg-amber-50 text-amber-700 border-amber-200" },
  rate_limited: { label: "Rate Limited", cls: "bg-orange-50 text-orange-700 border-orange-200" },
  unknown:      { label: "Unknown",      cls: "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700" },
};

const STATUS_BADGE: Record<AgentStatus, string> = {
  idle:    "bg-green-50 text-green-700 border-green-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  offline: "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700",
  error:   "bg-red-50 text-red-700 border-red-200",
};

const PERMISSION_MODES: { value: ClaudePermissionMode; label: string }[] = [
  { value: "workspace_write", label: "Workspace Write (default)" },
  { value: "read_only",       label: "Read Only" },
  { value: "full_autonomous", label: "Full Autonomous (--dangerously-skip-permissions)" },
];

const PERMISSION_LABEL: Record<ClaudePermissionMode, string> = {
  read_only:       "Read Only",
  workspace_write: "Workspace Write",
  full_autonomous: "Full Autonomous",
};

const THRESHOLD = 90;

function UsageBar({ label, pct, resets }: { label: string; pct: number | null | undefined; resets: string | null }) {
  const known = pct != null;
  const p = pct ?? 0;
  const color = p >= THRESHOLD ? "bg-red-500" : p >= 70 ? "bg-amber-400" : "bg-emerald-500";
  const blocked = p >= THRESHOLD;
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className={`text-xs font-semibold ${blocked ? "text-red-600" : "text-zinc-600 dark:text-zinc-400"}`}>
          {known ? `${p}%` : "—"}
        </span>
      </div>
      <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2 mb-1">
        <div
          className={`h-2 rounded-full transition-all ${known ? color : "bg-zinc-300"}`}
          style={{ width: known ? `${Math.min(p, 100)}%` : "0%" }}
        />
      </div>
      {resets && <p className="text-xs text-zinc-500">Resets {resets}</p>}
    </div>
  );
}

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);

  // Usage refresh
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Launch Claude
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<{ success: boolean; command?: string; error?: string } | null>(null);

  // Recovery
  const [recovering, setRecovering] = useState(false);
  const [recoverResult, setRecoverResult] = useState<{ success: boolean; message: string } | null>(null);

  // Edit modal
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState("");
  const [editWorkDir, setEditWorkDir] = useState("");
  const [editTmuxSession, setEditTmuxSession] = useState("");
  const [editMode, setEditMode] = useState<ClaudePermissionMode>("workspace_write");
  const [saving, setSaving] = useState(false);

  // Delete confirm
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Pause / resume
  const [resuming, setResuming] = useState(false);
  const [countdown, setCountdown] = useState<string | null>(null);

  function loadAgent() {
    fetch(`/api/agents/${id}`)
      .then((r) => {
        if (!r.ok) { router.push("/agents"); return null; }
        return r.json();
      })
      .then((data: Agent | null) => {
        if (!data) return;
        setAgent(data);
        setEditName(data.name);
        setEditWorkDir(data.workDir);
        setEditTmuxSession(data.tmuxSession);
        setEditMode(data.claudePermissionMode);
        setLoading(false);
      });
  }

  function loadTasks() {
    fetch(`/api/tasks?agentId=${id}`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: AgentTask[] | { tasks: AgentTask[] }) => {
        setTasks(Array.isArray(data) ? data : (data as { tasks: AgentTask[] }).tasks ?? []);
      })
      .catch(() => setTasks([]));
  }

  useEffect(() => {
    loadAgent();
    loadTasks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Live countdown while paused due to usage.
  useEffect(() => {
    if (!agent?.pausedDueToUsage) { setCountdown(null); return; }

    function computeCountdown() {
      const now = Date.now();
      const candidates = [agent!.claudeSessionResetsAt, agent!.claudeWeekResetsAt]
        .filter((s): s is string => s !== null)
        .map((s) => new Date(s).getTime())
        .filter((t) => t > now);
      if (candidates.length === 0) { setCountdown(null); return; }
      const ms = Math.min(...candidates) - now;
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setCountdown(h > 0
        ? `Resumes in ${h}h ${m}m ${s}s`
        : `Resumes in ${m}m ${s}s`);
    }

    computeCountdown();
    const interval = setInterval(computeCountdown, 1000);
    return () => clearInterval(interval);
  }, [agent]);

  async function handleResume() {
    setResuming(true);
    await fetch(`/api/agents/${id}/resume`, { method: "POST" });
    setResuming(false);
    loadAgent();
  }

  async function handleRefreshUsage() {
    setRefreshing(true);
    setRefreshError(null);
    const res = await fetch(`/api/agents/${id}/claude-usage`, { method: "POST" });
    const data = await res.json();
    setRefreshing(false);
    if (!res.ok || !data.success) {
      setRefreshError(data.error ?? "Failed to fetch usage");
    }
    loadAgent();
  }

  async function handleLaunchClaude() {
    setLaunching(true);
    setLaunchResult(null);
    const res = await fetch(`/api/agents/${id}/launch-claude`, { method: "POST" });
    const data = await res.json();
    setLaunching(false);
    setLaunchResult(data.success ? { success: true, command: data.command } : { success: false, error: data.error });
    if (data.success) loadAgent();
  }

  async function handleRecover() {
    setRecovering(true);
    setRecoverResult(null);
    try {
      const res = await fetch(`/api/agents/${id}/recover`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setRecoverResult({ success: true, message: "Session recovered successfully." });
        loadAgent();
      } else {
        setRecoverResult({ success: false, message: data.error ?? "Recovery failed" });
      }
    } catch {
      setRecoverResult({ success: false, message: "Request failed." });
    } finally {
      setRecovering(false);
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/agents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName,
        workDir: editWorkDir,
        tmuxSession: editTmuxSession,
        claudePermissionMode: editMode,
      }),
    });
    setSaving(false);
    setShowEdit(false);
    loadAgent();
  }

  async function handleDelete() {
    setDeleting(true);
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    router.push("/agents");
  }

  if (loading || !agent) {
    return (
      <div className="p-6 text-sm text-zinc-500">Loading…</div>
    );
  }

  const usageStale = agent.claudeUsageFetchedAt
    ? Date.now() - new Date(agent.claudeUsageFetchedAt).getTime() > 10 * 60 * 1000
    : false;

  const sessionPct = agent.claudeSessionPct;
  const weekPct = agent.claudeWeekPct;

  return (
    <div className="p-6 max-w-3xl">
      <BackLink href="/agents" label="Agents" />

      <div className="flex items-start justify-between mb-6">
        <div>
          <PageHeader
            title={agent.name}
            subtitle={`${agent.slug} · ${agent.server.name} (${agent.server.host})`}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-1">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_BADGE[agent.status]}`}>
            {agent.status}
          </span>
          <Link href={`/agents/${id}/terminal`}>
            <Btn variant="secondary" size="sm">Terminal</Btn>
          </Link>
          <Btn variant="secondary" size="sm" onClick={() => setShowEdit(true)}>Edit</Btn>
          <Btn variant="danger" size="sm" onClick={() => setShowDelete(true)}>Delete</Btn>
        </div>
      </div>

      {/* ── Usage Pause Banner ── */}
      {agent.pausedDueToUsage && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              ⏸ Queue paused — usage limit reached
            </p>
            {countdown && (
              <p className="text-sm text-amber-800 mt-0.5">{countdown}</p>
            )}
            {agent.pausedAt && (
              <p className="text-xs text-amber-700 mt-0.5">
                Paused at {new Date(agent.pausedAt).toLocaleString()}
              </p>
            )}
          </div>
          <Btn variant="secondary" size="sm" onClick={handleResume} disabled={resuming}>
            {resuming ? "Resuming…" : "Resume Now"}
          </Btn>
        </div>
      )}

      {/* ── Info grid ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">Working directory (HOME)</p>
          <p className="text-sm font-mono text-zinc-900 dark:text-zinc-100 break-all">{agent.workDir}</p>
        </div>
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">tmux session</p>
          <p className="text-sm font-mono text-zinc-900 dark:text-zinc-100">{agent.tmuxSession}</p>
        </div>
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">Permission mode</p>
          <p className="text-sm text-zinc-900 dark:text-zinc-100">{PERMISSION_LABEL[agent.claudePermissionMode]}</p>
        </div>
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">Tasks assigned</p>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{agent._count.tasks}</p>
        </div>
      </div>

      {/* ── Claude Usage ─────────────────────────────────────────────────────── */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Claude Usage</h2>
            {(() => {
              const ds = computeDisplayStatus(agent.claudeUsageFetchedAt, agent.claudeLastRefreshStatus);
              const { label, cls } = DISPLAY_STATUS_STYLE[ds];
              return (
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
                  {label}
                </span>
              );
            })()}
          </div>
          <div className="flex gap-2">
            <Btn
              variant="secondary"
              size="sm"
              onClick={handleRefreshUsage}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh Usage"}
            </Btn>
            <Btn
              variant="primary"
              size="sm"
              onClick={handleLaunchClaude}
              disabled={launching}
            >
              {launching ? "Launching…" : "Launch Claude"}
            </Btn>
          </div>
        </div>

        {refreshError && (
          <p className="text-sm text-red-600 mb-3">{refreshError}</p>
        )}

        {launchResult && (
          <div className={`mb-3 rounded-lg border p-3 text-sm ${launchResult.success ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-700"}`}>
            {launchResult.success
              ? <>Launched: <code className="font-mono text-xs">{launchResult.command}</code></>
              : launchResult.error}
          </div>
        )}

        <div className="mt-2 pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Recovery</p>
            <p className="text-xs text-zinc-500 mt-0.5">Relaunch Claude if offline. Will not run if there are active tasks.</p>
          </div>
          <Btn variant="secondary" size="sm" disabled={recovering} onClick={handleRecover}>
            {recovering ? "Recovering…" : "Recover Session"}
          </Btn>
        </div>
        {recoverResult && (
          <div className={`mt-2 rounded-lg border p-3 text-sm font-medium ${recoverResult.success ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"}`}>
            {recoverResult.success ? "✓ " : "✗ "}{recoverResult.message}
          </div>
        )}

        {agent.claudeUsageFetchedAt ? (
          <>
            {usageStale && (
              <p className="text-xs text-amber-600 mb-3">
                Usage data is over 10 minutes old — refresh for accurate readings.
              </p>
            )}
            <div className="space-y-4 mt-4">
              <UsageBar
                label="Current session"
                pct={sessionPct}
                resets={agent.claudeSessionResets}
              />
              <UsageBar
                label="Current week (all models)"
                pct={weekPct}
                resets={agent.claudeWeekResets}
              />
            </div>

            <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800 grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Reset Time</p>
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{agent.claudeWeekResets ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Usage Credits</p>
                <p className="text-sm text-zinc-800 dark:text-zinc-200">
                  {agent.claudeUsageCreditsEnabled === null || agent.claudeUsageCreditsEnabled === undefined
                    ? "—"
                    : agent.claudeUsageCreditsEnabled
                      ? "On"
                      : "Off"}
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-400 mt-3">
              Last updated {new Date(agent.claudeUsageFetchedAt).toLocaleString()}
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500 mt-4">
            No usage data yet. Click <strong>Refresh Usage</strong> to fetch from the server.
          </p>
        )}
      </section>

      {/* ── First-time setup instructions (shown when offline) ───────────────── */}
      {agent.status === "offline" && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 mb-6">
          <h2 className="font-semibold text-amber-900 mb-2">First-time setup</h2>
          <p className="text-sm text-amber-800 mb-3">
            SSH into <strong>{agent.server.host}</strong> and run these commands to set up
            this agent&apos;s isolated home directory and authenticate Claude CLI:
          </p>
          <pre className="text-xs font-mono bg-amber-100 rounded p-3 whitespace-pre-wrap text-amber-900">{`# 1. Create the agent home directory
mkdir -p ${agent.workDir}

# 2. Authenticate Claude CLI for this agent
HOME=${agent.workDir} claude login

# 3. Then click "Launch Claude" above to start the tmux session`}</pre>
        </section>
      )}

      {/* ── Assigned tasks ───────────────────────────────────────────────────── */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Assigned Tasks</h2>
        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-500">No tasks assigned to this agent yet.</p>
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <Link
                key={t.id}
                href={`/tasks/${t.id}`}
                className="flex items-center justify-between p-3 rounded-lg border border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:bg-zinc-950 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t.title}</p>
                  <p className="text-xs text-zinc-500">{t.project.name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{t.priority}</span>
                  <span className="text-xs font-medium capitalize text-zinc-700 dark:text-zinc-300">{t.status}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ── Edit modal ───────────────────────────────────────────────────────── */}
      {showEdit && (
        <Modal title="Edit Agent" size="md" onClose={() => setShowEdit(false)}>
          <form onSubmit={handleSaveEdit} className="space-y-4">
            <FormField label="Name" required>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className={inputCls}
                required
              />
            </FormField>
            <FormField
              label="Working directory (HOME)"
              hint="Claude config (~/.claude/) will be stored here"
              required
            >
              <input
                type="text"
                value={editWorkDir}
                onChange={(e) => setEditWorkDir(e.target.value)}
                className={`${inputCls} font-mono`}
                required
              />
            </FormField>
            <FormField label="tmux session name" required>
              <input
                type="text"
                value={editTmuxSession}
                onChange={(e) => setEditTmuxSession(e.target.value)}
                className={`${inputCls} font-mono`}
                required
              />
            </FormField>
            <FormField label="Permission mode">
              <select
                value={editMode}
                onChange={(e) => setEditMode(e.target.value as ClaudePermissionMode)}
                className={inputCls}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </FormField>
            <ModalActions>
              <Btn type="button" variant="secondary" onClick={() => setShowEdit(false)}>Cancel</Btn>
              <Btn type="submit" variant="primary" disabled={saving}>{saving ? "Saving…" : "Save"}</Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {/* ── Delete confirm modal ─────────────────────────────────────────────── */}
      {showDelete && (
        <Modal title="Delete Agent" size="md" onClose={() => setShowDelete(false)}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">
            Delete <strong>{agent.name}</strong>? Tasks assigned to this agent will be unassigned.
            This cannot be undone.
          </p>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setShowDelete(false)}>Cancel</Btn>
            <Btn variant="danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete Agent"}
            </Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}
