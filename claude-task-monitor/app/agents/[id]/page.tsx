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
  createdAt: string;
  updatedAt: string;
  server: { id: string; name: string; host: string; username: string; port: number };
  _count: { tasks: number };
}

const STATUS_BADGE: Record<AgentStatus, string> = {
  idle:    "bg-green-50 text-green-700 border-green-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  offline: "bg-zinc-100 text-zinc-600 border-zinc-200",
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

function UsageBar({ label, pct, resets }: { label: string; pct: number; resets: string | null }) {
  const color = pct >= THRESHOLD ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-500";
  const blocked = pct >= THRESHOLD;
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs font-medium text-zinc-700">{label}</span>
        <span className={`text-xs font-semibold ${blocked ? "text-red-600" : "text-zinc-600"}`}>
          {pct}%
        </span>
      </div>
      <div className="w-full bg-zinc-100 rounded-full h-2 mb-1">
        <div
          className={`h-2 rounded-full transition-all ${color}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
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

  const sessionPct = agent.claudeSessionPct ?? 0;
  const weekPct = agent.claudeWeekPct ?? 0;

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

      {/* ── Info grid ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">Working directory (HOME)</p>
          <p className="text-sm font-mono text-zinc-900 break-all">{agent.workDir}</p>
        </div>
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">tmux session</p>
          <p className="text-sm font-mono text-zinc-900">{agent.tmuxSession}</p>
        </div>
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">Permission mode</p>
          <p className="text-sm text-zinc-900">{PERMISSION_LABEL[agent.claudePermissionMode]}</p>
        </div>
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-500 font-medium mb-0.5">Tasks assigned</p>
          <p className="text-sm font-semibold text-zinc-900">{agent._count.tasks}</p>
        </div>
      </div>

      {/* ── Claude Usage ─────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-zinc-900">Claude Usage</h2>
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

        {agent.claudeUsageFetchedAt ? (
          <>
            {usageStale && (
              <p className="text-xs text-amber-600 mb-3">
                Usage data is over 10 minutes old — refresh for accurate readings.
              </p>
            )}
            <div className="space-y-4">
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
            <p className="text-xs text-zinc-400 mt-3">
              Last updated {new Date(agent.claudeUsageFetchedAt).toLocaleString()}
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500">
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
      <section className="bg-white rounded-xl border border-zinc-200 p-5">
        <h2 className="font-semibold text-zinc-900 mb-4">Assigned Tasks</h2>
        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-500">No tasks assigned to this agent yet.</p>
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <Link
                key={t.id}
                href={`/tasks/${t.id}`}
                className="flex items-center justify-between p-3 rounded-lg border border-zinc-100 hover:bg-zinc-50 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-900">{t.title}</p>
                  <p className="text-xs text-zinc-500">{t.project.name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{t.priority}</span>
                  <span className="text-xs font-medium capitalize text-zinc-700">{t.status}</span>
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
          <p className="text-sm text-zinc-700 mb-4">
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
