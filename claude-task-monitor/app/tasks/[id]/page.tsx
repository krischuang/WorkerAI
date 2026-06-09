"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import {
  BackLink,
  LoadingState,
  Modal,
  Btn,
  ModalActions,
  FormField,
  inputCls,
} from "@/app/_components/ui";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServerUsage {
  id: string;
  name: string;
  host: string;
  claudeSessionPct: number | null;
  claudeSessionResets: string | null;
  claudeSessionResetsAt: string | null;
  claudeWeekPct: number | null;
  claudeWeekResets: string | null;
  claudeWeekResetsAt: string | null;
  claudeUsageFetchedAt: string | null;
}

interface ServerOption {
  id: string;
  name: string;
  host: string;
}

interface AgentUsage {
  id: string;
  name: string;
  slug: string;
  tmuxSession: string;
  workDir: string;
  status: string;
  claudePermissionMode: string;
  claudeSessionPct: number | null;
  claudeSessionResets: string | null;
  claudeSessionResetsAt: string | null;
  claudeWeekPct: number | null;
  claudeWeekResets: string | null;
  claudeWeekResetsAt: string | null;
  claudeUsageFetchedAt: string | null;
  server: { id: string; name: string; host: string };
}

interface AgentOption {
  id: string;
  name: string;
  slug: string;
  server: { id: string; name: string; host: string };
}

interface ExecutionLog {
  id: string;
  status: string;
  logText: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  taskType: string;
  estimatedCostLevel: string;
  resultSummary: string | null;
  nextAction: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; name: string; priority: string };
  server: ServerUsage | null;
  agent: AgentUsage | null;
  executionLogs: ExecutionLog[];
}

interface BlockInfo {
  sessionPct: number;
  weekPct: number;
  sessionBlocked: boolean;
  weekBlocked: boolean;
  sessionResets: string | null;
  weekResets: string | null;
  nearestResetsAt: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const THRESHOLD = 90;

function pctColor(pct: number) {
  if (pct >= THRESHOLD) return "bg-red-500";
  if (pct >= 70) return "bg-amber-400";
  return "bg-emerald-500";
}

function UsageBar({ label, pct, resets }: { label: string; pct: number; resets: string | null }) {
  const color = pctColor(pct);
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
      {resets && (
        <p className="text-xs text-zinc-500">Resets {resets}</p>
      )}
    </div>
  );
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const STATUS_BUTTONS = [
  { label: "Queued", status: "queued", color: "bg-violet-700 hover:bg-violet-800" },
  { label: "Running", status: "running", color: "bg-blue-700 hover:bg-blue-800" },
  { label: "Paused", status: "paused", color: "bg-amber-600 hover:bg-amber-700" },
  { label: "Completed", status: "completed", color: "bg-green-700 hover:bg-green-800" },
  { label: "Failed", status: "failed", color: "bg-red-700 hover:bg-red-800" },
];

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [task, setTask] = useState<Task | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("");
  const [assigningServer, setAssigningServer] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [assigningAgent, setAssigningAgent] = useState(false);

  // Run state
  const [runState, setRunState] = useState<"idle" | "sending" | "blocked" | "success" | "error">("idle");
  const [blockInfo, setBlockInfo] = useState<BlockInfo | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string>("");

  // Review state
  const [reviewState, setReviewState] = useState<"idle" | "reviewing" | "done" | "incomplete" | "error">("idle");
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Modals
  const [checkingCompletion, setCheckingCompletion] = useState(false);
  const [showLogForm, setShowLogForm] = useState(false);
  const [showSummaryForm, setShowSummaryForm] = useState(false);
  const [logForm, setLogForm] = useState({
    status: "completed",
    logText: "",
    errorMessage: "",
    outputSummary: "",
  });
  const [summaryForm, setSummaryForm] = useState({ resultSummary: "", nextAction: "" });

  // Keep track of auto-retry timer
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function loadTask() {
    fetch(`/api/tasks/${id}`)
      .then((r) => {
        if (!r.ok) { router.push("/tasks"); return null; }
        return r.json();
      })
      .then((data: Task | null) => {
        if (!data) return;
        setTask(data);
        setSummaryForm({
          resultSummary: data.resultSummary ?? "",
          nextAction: data.nextAction ?? "",
        });
        // Seed pickers with current assignments
        if (data.server) setSelectedServerId(data.server.id);
        if (data.agent) setSelectedAgentId(data.agent.id);
      });
  }

  function loadServers() {
    fetch("/api/servers")
      .then((r) => r.json())
      .then((data: ServerOption[]) => setServers(data));
  }

  function loadAgents() {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data: AgentOption[]) => setAgents(data))
      .catch(() => {});
  }

  useEffect(() => {
    loadTask();
    loadServers();
    loadAgents();
  }, [id]);

  // Countdown ticker when blocked
  useEffect(() => {
    if (runState !== "blocked" || !blockInfo?.nearestResetsAt) {
      setCountdown("");
      return;
    }

    const resetMs = new Date(blockInfo.nearestResetsAt).getTime();

    const tick = () => {
      const remaining = resetMs - Date.now();
      setCountdown(formatCountdown(remaining));

      if (remaining <= 0) {
        // Reset time has passed — auto-retry
        handleRun();
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [runState, blockInfo]);

  async function assignAgent() {
    if (!selectedAgentId) return;
    setAssigningAgent(true);
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: selectedAgentId, serverId: null }),
    });
    setAssigningAgent(false);
    setSelectedServerId("");
    setRunState("idle");
    setBlockInfo(null);
    loadTask();
  }

  // Cleanup retry timer on unmount
  useEffect(() => () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  // Auto-poll for task completion while running
  useEffect(() => {
    if (task?.status !== "running") return;

    const poll = async () => {
      const res = await fetch(`/api/tasks/${id}/check-completion`, { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.completed) loadTask();
    };

    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.status, id]);

  async function assignServer() {
    if (!selectedServerId) return;
    setAssigningServer(true);
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: selectedServerId, agentId: null }),
    });
    setAssigningServer(false);
    setSelectedAgentId("");
    setRunState("idle");
    setBlockInfo(null);
    loadTask();
  }

  async function handleRun() {
    setRunState("sending");
    setRunError(null);
    setBlockInfo(null);

    const res = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      setRunState("error");
      setRunError(data.error ?? "Failed to run task");
      return;
    }

    if (data.blocked) {
      setRunState("blocked");
      setBlockInfo({
        sessionPct: data.sessionPct,
        weekPct: data.weekPct,
        sessionBlocked: data.sessionBlocked,
        weekBlocked: data.weekBlocked,
        sessionResets: data.sessionResets,
        weekResets: data.weekResets,
        nearestResetsAt: data.nearestResetsAt,
      });
      return;
    }

    if (data.success) {
      setRunState("success");
      loadTask();
    }
  }

  async function updateStatus(status: string) {
    await fetch(`/api/tasks/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadTask();
  }

  async function checkCompletion() {
    setCheckingCompletion(true);
    try {
      const res = await fetch(`/api/tasks/${id}/check-completion`, { method: "POST" });
      const data = await res.json();
      if (data.completed) loadTask();
    } finally {
      setCheckingCompletion(false);
    }
  }

  async function handleReview() {
    setReviewState("reviewing");
    setReviewError(null);
    try {
      const res = await fetch(`/api/tasks/${id}/review`, { method: "POST" });
      let data: { verdict?: string; error?: string } = {};
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) {
        setReviewState("error");
        setReviewError(data.error ?? `Server error (${res.status})`);
        return;
      }
      setReviewState(data.verdict === "done" ? "done" : "incomplete");
      loadTask();
    } catch {
      setReviewState("error");
      setReviewError("Network error — please try again");
    }
  }

  async function handleAddLog(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/tasks/${id}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...logForm, finishedAt: new Date().toISOString() }),
    });
    setShowLogForm(false);
    setLogForm({ status: "completed", logText: "", errorMessage: "", outputSummary: "" });
    loadTask();
  }

  async function handleSaveSummary(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summaryForm),
    });
    setShowSummaryForm(false);
    loadTask();
  }

  if (!task) return <LoadingState />;

  const assignedServer = task.server;
  const assignedAgent = task.agent;

  // If agent is assigned, use agent usage; otherwise fall back to server usage
  const usageSource = assignedAgent ?? assignedServer;
  const usageStale = usageSource?.claudeUsageFetchedAt
    ? Date.now() - new Date(usageSource.claudeUsageFetchedAt).getTime() > 10 * 60 * 1000
    : false;

  const sessionPct = usageSource?.claudeSessionPct ?? 0;
  const weekPct = usageSource?.claudeWeekPct ?? 0;
  const usageBlocked = sessionPct >= THRESHOLD || weekPct >= THRESHOLD;

  return (
    <div className="p-8 max-w-4xl">
      <BackLink href="/tasks" label="Tasks" />

      <div className="flex items-start justify-between mb-6">
        <div>
          <p className="text-xs text-zinc-500 mb-1">{task.project.name}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{task.title}</h1>
          {task.description && (
            <p className="text-sm text-zinc-700 mt-1 max-w-2xl">{task.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          <PriorityBadge priority={task.priority} />
          <StatusBadge status={task.status} />
          {task.status === "completed" && (
            <Btn
              variant="secondary"
              size="sm"
              onClick={handleReview}
              disabled={reviewState === "reviewing"}
            >
              {reviewState === "reviewing" ? "Reviewing…" : "Review"}
            </Btn>
          )}
        </div>
      </div>

      {/* ── Review result banner ─────────────────────────────────────────────── */}
      {reviewState === "done" && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 font-medium">
          Archived — Claude confirmed complete
        </div>
      )}
      {reviewState === "incomplete" && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 font-medium">
          Back to pending — Claude found it incomplete
        </div>
      )}
      {reviewState === "error" && reviewError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {reviewError}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-600 font-medium mb-0.5">Type</p>
          <p className="text-sm font-semibold text-zinc-900 capitalize">{task.taskType}</p>
        </div>
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-600 font-medium mb-0.5">Estimated Cost</p>
          <p className="text-sm font-semibold text-zinc-900 capitalize">{task.estimatedCostLevel}</p>
        </div>
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-600 font-medium mb-0.5">Project Priority</p>
          <p className="text-sm font-semibold text-zinc-900">{task.project.priority}</p>
        </div>
      </div>

      {/* ── Run ─────────────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
        <h2 className="font-semibold text-zinc-900 mb-4">Run</h2>

        {/* Assignment options — agent (preferred) or legacy server */}
        <div className="space-y-3 mb-4">
          {/* Agent assignment row */}
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                Agent
                {assignedAgent && (
                  <span className="ml-2 text-zinc-400 font-normal">
                    currently: {assignedAgent.name} ({assignedAgent.server.host})
                  </span>
                )}
              </label>
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className={inputCls}
              >
                <option value="">— select an agent —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.server.name} ({a.server.host})
                  </option>
                ))}
              </select>
            </div>
            <Btn
              variant="secondary"
              onClick={assignAgent}
              disabled={!selectedAgentId || assigningAgent || selectedAgentId === assignedAgent?.id}
            >
              {assigningAgent ? "Saving…" : assignedAgent ? "Change" : "Assign"}
            </Btn>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-zinc-100" />
            <span className="text-xs text-zinc-400">or use legacy server</span>
            <div className="flex-1 h-px bg-zinc-100" />
          </div>

          {/* Server assignment row */}
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                Server (legacy)
                {assignedServer && !assignedAgent && (
                  <span className="ml-2 text-zinc-400 font-normal">
                    currently: {assignedServer.name}
                  </span>
                )}
              </label>
              <select
                value={selectedServerId}
                onChange={(e) => setSelectedServerId(e.target.value)}
                className={inputCls}
              >
                <option value="">— select a server —</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </option>
                ))}
              </select>
            </div>
            <Btn
              variant="secondary"
              onClick={assignServer}
              disabled={!selectedServerId || assigningServer || selectedServerId === assignedServer?.id}
            >
              {assigningServer ? "Saving…" : assignedServer ? "Change" : "Assign"}
            </Btn>
          </div>
        </div>

        {/* Nothing assigned */}
        {!assignedAgent && !assignedServer && (
          <p className="text-sm text-zinc-500">Assign an agent or server to enable execution.</p>
        )}

        {/* Usage + run controls */}
        {(assignedAgent || assignedServer) && (
          <>
            {/* Usage source label */}
            {assignedAgent && (
              <p className="text-xs text-zinc-500 mb-3">
                Usage from agent <strong>{assignedAgent.name}</strong>
                {" "}(<a href={`/agents/${assignedAgent.id}`} className="text-blue-600 hover:underline">view agent</a>)
              </p>
            )}

            {/* Usage meters */}
            {usageSource?.claudeUsageFetchedAt ? (
              <div className="space-y-3 mb-4">
                {usageStale && (
                  <p className="text-xs text-amber-600">
                    Usage data is over 10 minutes old — refresh from the {assignedAgent ? "agent" : "server"} page for accurate readings.
                  </p>
                )}
                <UsageBar
                  label="Current session"
                  pct={sessionPct}
                  resets={usageSource.claudeSessionResets}
                />
                <UsageBar
                  label="Current week (all models)"
                  pct={weekPct}
                  resets={usageSource.claudeWeekResets}
                />
              </div>
            ) : (
              <p className="text-xs text-zinc-500 mb-4">
                No usage data yet — visit the {assignedAgent ? "agent" : "server"} page and refresh Claude usage first.
              </p>
            )}

            {/* Run button / states */}
            {runState === "idle" && (
              <Btn
                variant="primary"
                onClick={handleRun}
                disabled={usageBlocked}
              >
                {usageBlocked
                  ? "Usage limit reached — cannot run"
                  : assignedAgent
                  ? `Run on ${assignedAgent.name}`
                  : "Run on Server"}
              </Btn>
            )}

            {runState === "sending" && (
              <Btn variant="primary" disabled>Sending to Claude…</Btn>
            )}

            {runState === "success" && (
              <div className="flex items-center gap-3">
                <span className="text-sm text-emerald-700 font-medium">
                  Task sent to Claude — status set to Running
                </span>
                <Btn variant="ghost" onClick={() => setRunState("idle")}>Run again</Btn>
              </div>
            )}

            {runState === "error" && (
              <div className="space-y-2">
                <p className="text-sm text-red-700">{runError}</p>
                <Btn variant="secondary" onClick={() => setRunState("idle")}>Retry</Btn>
              </div>
            )}

            {runState === "blocked" && blockInfo && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-amber-600 font-semibold text-sm">Usage limit reached</span>
                  <span className="text-xs text-zinc-500">— waiting for reset</span>
                </div>

                <div className="space-y-2">
                  {blockInfo.sessionBlocked && (
                    <div className="text-sm">
                      <span className="text-zinc-700 font-medium">Session: </span>
                      <span className="text-red-600 font-semibold">{blockInfo.sessionPct}%</span>
                      {blockInfo.sessionResets && (
                        <span className="text-zinc-500 ml-2">resets {blockInfo.sessionResets}</span>
                      )}
                    </div>
                  )}
                  {blockInfo.weekBlocked && (
                    <div className="text-sm">
                      <span className="text-zinc-700 font-medium">Week: </span>
                      <span className="text-red-600 font-semibold">{blockInfo.weekPct}%</span>
                      {blockInfo.weekResets && (
                        <span className="text-zinc-500 ml-2">resets {blockInfo.weekResets}</span>
                      )}
                    </div>
                  )}
                </div>

                {blockInfo.nearestResetsAt && (
                  <div className="flex items-center gap-3 pt-1">
                    <div>
                      <p className="text-xs text-zinc-500 mb-0.5">Auto-running in</p>
                      <p className="text-xl font-mono font-semibold text-zinc-900">{countdown}</p>
                    </div>
                    <Btn variant="ghost" onClick={handleRun}>Retry now</Btn>
                  </div>
                )}

                {!blockInfo.nearestResetsAt && (
                  <Btn variant="secondary" onClick={handleRun}>Retry</Btn>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Execution Controls ──────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
        <h2 className="font-semibold text-zinc-900 mb-3">Execution Controls</h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_BUTTONS.map(({ label, status, color }) => (
            <button
              key={status}
              onClick={() => updateStatus(status)}
              disabled={task.status === status}
              className={`text-sm text-white font-medium px-4 py-2 rounded-lg transition-colors ${color} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Mark {label}
            </button>
          ))}
          <Btn variant="ghost" onClick={() => setShowLogForm(true)}>+ Add Log</Btn>
          <Btn variant="ghost" onClick={() => setShowSummaryForm(true)}>Save Result</Btn>
        </div>
        {task.status === "running" && (
          <div className="mt-3 flex items-center gap-3">
            <Btn
              variant="secondary"
              size="sm"
              disabled={checkingCompletion}
              onClick={checkCompletion}
            >
              {checkingCompletion ? "Checking…" : "Check if Done"}
            </Btn>
            <span className="text-xs text-zinc-500">Auto-checks every 30 s</span>
          </div>
        )}
      </section>

      {/* ── Result / Next Action ─────────────────────────────────────────────── */}
      {(task.resultSummary || task.nextAction) && (
        <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6 space-y-4">
          {task.resultSummary && (
            <div>
              <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide mb-1.5">
                Result Summary
              </p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{task.resultSummary}</p>
            </div>
          )}
          {task.nextAction && (
            <div>
              <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide mb-1.5">
                Next Action
              </p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{task.nextAction}</p>
            </div>
          )}
        </section>
      )}

      {/* ── Execution Logs ───────────────────────────────────────────────────── */}
      <section>
        <h2 className="font-semibold text-zinc-900 mb-3">
          Execution Logs ({task.executionLogs.length})
        </h2>
        {task.executionLogs.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-6 text-center">
            <p className="text-sm text-zinc-600">No execution logs yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {task.executionLogs.map((log) => (
              <div key={log.id} className="bg-white rounded-xl border border-zinc-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <StatusBadge status={log.status} />
                  <span className="text-xs text-zinc-600">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
                {log.logText && (
                  <pre className="text-xs text-zinc-700 bg-zinc-50 rounded-lg p-3 mt-2 overflow-x-auto whitespace-pre-wrap font-mono">
                    {log.logText}
                  </pre>
                )}
                {log.outputSummary && (
                  <p className="text-sm text-zinc-800 mt-2">
                    <span className="font-medium text-zinc-700">Output: </span>
                    {log.outputSummary}
                  </p>
                )}
                {log.errorMessage && (
                  <p className="text-sm text-red-700 mt-2">
                    <span className="font-medium">Error: </span>
                    {log.errorMessage}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Add Log Modal ────────────────────────────────────────────────────── */}
      {showLogForm && (
        <Modal title="Add Execution Log" onClose={() => setShowLogForm(false)} size="lg">
          <form onSubmit={handleAddLog} className="space-y-4">
            <FormField label="Status">
              <select
                value={logForm.status}
                onChange={(e) => setLogForm({ ...logForm, status: e.target.value })}
                className={inputCls}
              >
                {["pending", "running", "paused", "completed", "failed"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Log Text">
              <textarea
                value={logForm.logText}
                onChange={(e) => setLogForm({ ...logForm, logText: e.target.value })}
                rows={5}
                placeholder="Paste Claude's output or your notes here…"
                className={`${inputCls} font-mono`}
              />
            </FormField>
            <FormField label="Output Summary">
              <input
                value={logForm.outputSummary}
                onChange={(e) => setLogForm({ ...logForm, outputSummary: e.target.value })}
                placeholder="One-line summary of what was produced"
                className={inputCls}
              />
            </FormField>
            <FormField label="Error Message">
              <input
                value={logForm.errorMessage}
                onChange={(e) => setLogForm({ ...logForm, errorMessage: e.target.value })}
                placeholder="Error details if status is failed"
                className={inputCls}
              />
            </FormField>
            <ModalActions>
              <Btn type="submit" variant="primary" className="flex-1">Save Log</Btn>
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => setShowLogForm(false)}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {/* ── Result Summary Modal ─────────────────────────────────────────────── */}
      {showSummaryForm && (
        <Modal title="Result Summary & Next Action" onClose={() => setShowSummaryForm(false)} size="lg">
          <form onSubmit={handleSaveSummary} className="space-y-4">
            <FormField label="Result Summary">
              <textarea
                value={summaryForm.resultSummary}
                onChange={(e) => setSummaryForm({ ...summaryForm, resultSummary: e.target.value })}
                rows={4}
                placeholder="What was accomplished?"
                className={inputCls}
              />
            </FormField>
            <FormField label="Next Action">
              <textarea
                value={summaryForm.nextAction}
                onChange={(e) => setSummaryForm({ ...summaryForm, nextAction: e.target.value })}
                rows={3}
                placeholder="What should happen next?"
                className={inputCls}
              />
            </FormField>
            <ModalActions>
              <Btn type="submit" variant="primary" className="flex-1">Save</Btn>
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => setShowSummaryForm(false)}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}
