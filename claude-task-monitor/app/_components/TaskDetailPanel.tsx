"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { DependencyManager } from "@/app/_components/DependencyManager";

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
  capacityScore: number | null;
  activeTaskCount: number;
  maxConcurrentTasks: number;
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
  timeoutMinutes: number | null;
  resolvedTimeoutMinutes: number;
  timeoutExpiresAt: string | null;
  resultSummary: string | null;
  nextAction: string | null;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  reviewStatus: string | null;
  reviewAttempts: number;
  reviewVerdictNotes: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
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

const THRESHOLD = 90;

// Shared backoff schedule for loadTask retries and the completion poller.
const FETCH_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const FETCH_MAX_ATTEMPTS = 8;

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

function formatMinutes(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function TimeoutProgressBar({
  timeoutExpiresAt,
  resolvedTimeoutMinutes,
}: {
  timeoutExpiresAt: string | null;
  resolvedTimeoutMinutes: number;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!timeoutExpiresAt) return null;

  const expiresMs = new Date(timeoutExpiresAt).getTime();
  const totalMs = resolvedTimeoutMinutes * 60_000;
  const startMs = expiresMs - totalMs;
  const elapsedMs = Math.max(0, now - startMs);
  const remainingMs = Math.max(0, expiresMs - now);
  const pct = Math.min(100, (elapsedMs / totalMs) * 100);

  const isExpired = remainingMs === 0;
  const isWarning = pct >= 80;

  const barColor = isExpired
    ? "bg-red-600"
    : isWarning
    ? "bg-amber-500"
    : "bg-blue-500";

  return (
    <div className="mt-3 p-3 bg-zinc-50 rounded-lg border border-zinc-200">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs font-medium text-zinc-700">Execution timeout</span>
        <span className={`text-xs font-semibold ${isExpired ? "text-red-600" : isWarning ? "text-amber-600" : "text-zinc-600"}`}>
          {isExpired ? "Timed out" : `${formatMinutes(remainingMs)} remaining`}
        </span>
      </div>
      <div className="w-full bg-zinc-200 rounded-full h-2 mb-1">
        <div
          className={`h-2 rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-zinc-500">
        {formatMinutes(elapsedMs)} elapsed of {resolvedTimeoutMinutes}min limit
      </p>
    </div>
  );
}

// ── Audit Timeline ─────────────────────────────────────────────────────────

interface AuditEvent {
  id: string;
  eventType: string;
  actorType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const EVENT_LABEL: Record<string, string> = {
  "task.created":           "Task created",
  "task.queued":            "Queued for execution",
  "task.dispatched":        "Dispatched to Claude",
  "task.completed":         "Marked completed",
  "task.failed":            "Marked failed",
  "task.timeout":           "Execution timed out",
  "task.retried":           "Retried",
  "task.review.sent":              "Review sent",
  "task.review.done":              "Review: done",
  "task.review.incomplete":        "Review: incomplete",
  "task.review.max_attempts_reached": "Review: max attempts reached",
};

const EVENT_DOT: Record<string, string> = {
  "task.created":           "bg-zinc-400",
  "task.queued":            "bg-violet-500",
  "task.dispatched":        "bg-blue-500",
  "task.completed":         "bg-green-500",
  "task.failed":            "bg-red-500",
  "task.timeout":           "bg-red-400",
  "task.retried":           "bg-amber-400",
  "task.review.sent":              "bg-sky-400",
  "task.review.done":              "bg-emerald-500",
  "task.review.incomplete":        "bg-amber-500",
  "task.review.max_attempts_reached": "bg-red-500",
};

function AuditTimeline({ taskId }: { taskId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  function load(cursor?: string) {
    const url = `/api/audit?entityType=task&entityId=${taskId}${cursor ? `&cursor=${cursor}` : ""}`;
    return fetch(url)
      .then((r) => r.json())
      .then((data: { events: AuditEvent[]; nextCursor: string | null }) => {
        setEvents((prev) => cursor ? [...prev, ...data.events] : data.events);
        setNextCursor(data.nextCursor);
      });
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    load(nextCursor).finally(() => setLoadingMore(false));
  }

  if (loading) return null;
  if (events.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="font-semibold text-zinc-900 mb-3">Timeline</h2>
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <ol className="relative border-l border-zinc-200 ml-2 space-y-4">
          {events.map((ev) => (
            <li key={ev.id} className="pl-5">
              <span className={`absolute left-[-4.5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white ${EVENT_DOT[ev.eventType] ?? "bg-zinc-300"}`} />
              <p className="text-sm font-medium text-zinc-900">
                {EVENT_LABEL[ev.eventType] ?? ev.eventType}
              </p>
              <p className="text-xs text-zinc-500">
                {new Date(ev.createdAt).toLocaleString()}
                {ev.actorType !== "system" && ` · ${ev.actorType}`}
              </p>
            </li>
          ))}
        </ol>
        {nextCursor && (
          <div className="mt-4 text-center">
            <Btn variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Btn>
          </div>
        )}
      </div>
    </section>
  );
}

const STATUS_BUTTONS = [
  { label: "Pending", status: "pending", color: "bg-zinc-600 hover:bg-zinc-700" },
  { label: "Queued", status: "queued", color: "bg-violet-700 hover:bg-violet-800" },
  { label: "Running", status: "running", color: "bg-blue-700 hover:bg-blue-800" },
  { label: "Paused", status: "paused", color: "bg-amber-600 hover:bg-amber-700" },
  { label: "Completed", status: "completed", color: "bg-green-700 hover:bg-green-800" },
  { label: "Failed", status: "failed", color: "bg-red-700 hover:bg-red-800" },
];

const ALLOWED_STATUS_TRANSITIONS: Record<string, Set<string>> = {
  pending:   new Set(["queued", "paused"]),
  queued:    new Set(["running", "pending", "paused"]),
  running:   new Set(["completed", "failed", "paused"]),
  paused:    new Set(["queued", "pending"]),
  completed: new Set(["archived", "pending"]),
  failed:    new Set(["pending"]),
  archived:  new Set([]),
};

export function TaskDetailPanel({
  id,
  onClose,
}: {
  id: string;
  onClose?: () => void;
}) {
  const router = useRouter();

  const [task, setTask] = useState<Task | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("");
  const [assigningServer, setAssigningServer] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [assigningAgent, setAssigningAgent] = useState(false);

  const [runState, setRunState] = useState<"idle" | "sending" | "blocked" | "success" | "error">("idle");
  const [blockInfo, setBlockInfo] = useState<BlockInfo | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string>("");

  const [reviewState, setReviewState] = useState<"idle" | "reviewing" | "done" | "incomplete" | "error">("idle");
  const [reviewError, setReviewError] = useState<string | null>(null);

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
  const [scheduleInput, setScheduleInput] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);

  const [cloning, setCloning] = useState(false);
  const [cloneResult, setCloneResult] = useState<{ id: string; title: string } | null>(null);

  const retryTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAttemptRef   = useRef(0);
  const pollAttemptRef   = useRef(0);
  const [pollConnState, setPollConnState] = useState<"ok" | "retrying" | "offline">("ok");

  function loadTask(attempt = 0) {
    fetch(`/api/tasks/${id}`)
      .then((r) => {
        if (!r.ok) {
          if (onClose) { onClose(); return null; }
          router.push("/tasks");
          return null;
        }
        loadAttemptRef.current = 0;
        setPollConnState("ok");
        return r.json();
      })
      .then((data: Task | null) => {
        if (!data) return;
        setTask(data);
        setSummaryForm({
          resultSummary: data.resultSummary ?? "",
          nextAction: data.nextAction ?? "",
        });
        if (data.server) setSelectedServerId(data.server.id);
        if (data.agent) setSelectedAgentId(data.agent.id);
      })
      .catch(() => {
        // Network error — retry with exponential backoff.
        const next = attempt + 1;
        loadAttemptRef.current = next;
        if (next <= FETCH_MAX_ATTEMPTS) {
          const delay = FETCH_BACKOFF_MS[Math.min(attempt, FETCH_BACKOFF_MS.length - 1)];
          setPollConnState("retrying");
          retryTimerRef.current = setTimeout(() => loadTask(next), delay);
        } else {
          setPollConnState("offline");
        }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (runState !== "blocked" || !blockInfo?.nearestResetsAt) {
      setCountdown("");
      return;
    }

    const resetMs = new Date(blockInfo.nearestResetsAt).getTime();

    const tick = () => {
      const remaining = resetMs - Date.now();
      setCountdown(formatCountdown(remaining));
      if (remaining <= 0) handleRun();
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  // Completion poller with exponential backoff on failure.
  // Uses recursive setTimeout so failure delays don't disturb the success cadence.
  useEffect(() => {
    if (task?.status !== "running") {
      setPollConnState("ok");
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollOnce() {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/tasks/${id}/check-completion`, { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        pollAttemptRef.current = 0;
        setPollConnState("ok");
        if (data.completed) { loadTask(); return; }
        // Schedule next regular poll after success.
        if (!cancelled) timer = setTimeout(pollOnce, 30_000);
      } catch {
        if (cancelled) return;
        const attempt = pollAttemptRef.current;
        const next = attempt + 1;
        pollAttemptRef.current = next;
        const delay = FETCH_BACKOFF_MS[Math.min(attempt, FETCH_BACKOFF_MS.length - 1)];
        if (next <= FETCH_MAX_ATTEMPTS) {
          setPollConnState("retrying");
          timer = setTimeout(pollOnce, delay);
        } else {
          setPollConnState("offline");
        }
      }
    }

    // First poll after the standard 30 s interval.
    timer = setTimeout(pollOnce, 30_000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
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

  async function handleClone() {
    setCloning(true);
    setCloneResult(null);
    const res = await fetch(`/api/tasks/${id}/clone`, { method: "POST" });
    setCloning(false);
    if (res.ok) {
      const data: { id: string; title: string } = await res.json();
      setCloneResult(data);
    }
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

  async function saveSchedule(isoOrNull: string | null) {
    setSavingSchedule(true);
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledFor: isoOrNull }),
    }).catch(() => {});
    setSavingSchedule(false);
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

  const usageSource = assignedAgent ?? assignedServer;
  const usageStale = usageSource?.claudeUsageFetchedAt
    ? Date.now() - new Date(usageSource.claudeUsageFetchedAt).getTime() > 10 * 60 * 1000
    : false;

  const sessionPct = usageSource?.claudeSessionPct ?? 0;
  const weekPct = usageSource?.claudeWeekPct ?? 0;
  const usageBlocked = sessionPct >= THRESHOLD || weekPct >= THRESHOLD;

  return (
    <div className={onClose ? "" : "p-8 max-w-4xl"}>
      {!onClose && <BackLink href="/tasks" label="Tasks" />}

      <div className="flex items-start justify-between mb-6">
        <div>
          <p className="text-xs text-zinc-500 mb-1">{task.project.name}</p>
          <h1 className={`font-semibold tracking-tight text-zinc-900 ${onClose ? "text-xl" : "text-2xl"}`}>
            {task.title}
          </h1>
          {task.description && (
            <p className="text-sm text-zinc-700 mt-1 max-w-2xl">{task.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          <PriorityBadge priority={task.priority} />
          <StatusBadge status={task.status} />
          {/* Poll connection status badge */}
          {pollConnState === "retrying" && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              <span className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
              Reconnecting…
            </span>
          )}
          {pollConnState === "offline" && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
              <span className="w-1 h-1 rounded-full bg-red-500" />
              Offline
            </span>
          )}
          <Btn
            variant="ghost"
            size="sm"
            onClick={handleClone}
            disabled={cloning}
          >
            {cloning ? "Duplicating…" : "Duplicate"}
          </Btn>
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

      {/* Review status banner — shown when review has run at least once */}
      {task.reviewStatus === "failed" && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="font-semibold">Review failed</span> — reached {task.reviewAttempts} consecutive incomplete verdict{task.reviewAttempts !== 1 ? "s" : ""}. Task left as completed; operator action required.
          {task.reviewVerdictNotes && (
            <p className="mt-1 text-red-700 whitespace-pre-wrap">{task.reviewVerdictNotes}</p>
          )}
        </div>
      )}
      {task.reviewStatus === "incomplete" && task.reviewAttempts > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">Review attempt {task.reviewAttempts}</span> returned incomplete. Task reset to pending for re-run ({3 - task.reviewAttempts} attempt{3 - task.reviewAttempts !== 1 ? "s" : ""} remaining before review fails).
        </div>
      )}
      {task.reviewAttempts > 0 && task.reviewStatus !== "failed" && task.reviewStatus !== "incomplete" && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-600">
          Review attempts: {task.reviewAttempts}
        </div>
      )}

      {/* Clone success banner */}
      {cloneResult && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 flex items-center justify-between gap-3">
          <span>
            Task duplicated —{" "}
            <a
              href={`/tasks/${cloneResult.id}`}
              className="font-medium underline underline-offset-2 hover:text-blue-900"
            >
              #{cloneResult.id.slice(-8)}
            </a>{" "}
            <span className="text-blue-700">{cloneResult.title}</span>
          </span>
          <button
            onClick={() => setCloneResult(null)}
            className="text-blue-500 hover:text-blue-700 shrink-0 text-lg leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
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

        <div className="space-y-3 mb-4">
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

          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-zinc-100" />
            <span className="text-xs text-zinc-400">or use legacy server</span>
            <div className="flex-1 h-px bg-zinc-100" />
          </div>

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
                    {s.name} ({s.host}){s.capacityScore !== null ? ` · ${Math.round(s.capacityScore)}% cap` : ""}
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

        {!assignedAgent && !assignedServer && (
          <p className="text-sm text-zinc-500">Assign an agent or server to enable execution.</p>
        )}

        {(assignedAgent || assignedServer) && (
          <>
            {assignedAgent && (
              <p className="text-xs text-zinc-500 mb-3">
                Usage from agent <strong>{assignedAgent.name}</strong>
                {" "}(<a href={`/agents/${assignedAgent.id}`} className="text-blue-600 hover:underline">view agent</a>)
              </p>
            )}

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

            {runState === "idle" && (
              <Btn variant="primary" onClick={handleRun} disabled={usageBlocked}>
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

      {/* ── Dependencies ─────────────────────────────────────────────────────── */}
      <DependencyManager taskId={id} projectId={task.project.id} />

      {/* ── Schedule Run ────────────────────────────────────────────────────── */}
      {(task.status === "pending" || task.scheduledFor) && (
        <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
          <h2 className="font-semibold text-zinc-900 mb-3">Schedule Run</h2>
          {task.scheduledFor ? (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm text-zinc-700">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-blue-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span>
                  Scheduled for{" "}
                  <strong>
                    {new Date(task.scheduledFor).toLocaleString(undefined, {
                      weekday: "short", month: "short", day: "numeric",
                      hour: "numeric", minute: "2-digit",
                    })}
                  </strong>
                </span>
              </div>
              <button
                onClick={() => saveSchedule(null)}
                disabled={savingSchedule}
                className="text-xs text-red-600 hover:text-red-800 font-medium underline disabled:opacity-50"
              >
                {savingSchedule ? "Cancelling…" : "Cancel schedule"}
              </button>
            </div>
          ) : (
            <div className="flex items-end gap-2 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs font-medium text-zinc-700 mb-1">Run at</label>
                <input
                  type="datetime-local"
                  value={scheduleInput}
                  onChange={(e) => setScheduleInput(e.target.value)}
                  min={new Date().toISOString().slice(0, 16)}
                  className={inputCls}
                />
              </div>
              <button
                onClick={() => {
                  if (!scheduleInput) return;
                  saveSchedule(new Date(scheduleInput).toISOString());
                  setScheduleInput("");
                }}
                disabled={!scheduleInput || savingSchedule}
                className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {savingSchedule ? "Saving…" : "Set Schedule"}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── Execution Controls ──────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
        <h2 className="font-semibold text-zinc-900 mb-3">Execution Controls</h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_BUTTONS.filter(({ status }) =>
            ALLOWED_STATUS_TRANSITIONS[task.status]?.has(status) ?? false
          ).map(({ label, status, color }) => (
            <button
              key={status}
              onClick={() => updateStatus(status)}
              className={`text-sm text-white font-medium px-4 py-2 rounded-lg transition-colors ${color}`}
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
        {task.status === "running" && task.progressPercent != null && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wide">
                Progress
              </p>
              <span className="text-xs font-mono text-zinc-600 dark:text-zinc-400">
                {task.progressPercent}%
              </span>
            </div>
            <div className="h-2 w-full bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{ width: `${task.progressPercent}%` }}
              />
            </div>
            {task.progressMessage && (
              <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
                {task.progressMessage}
              </p>
            )}
          </div>
        )}
        {task.status === "running" && task.timeoutExpiresAt && (
          <TimeoutProgressBar
            timeoutExpiresAt={task.timeoutExpiresAt}
            resolvedTimeoutMinutes={task.resolvedTimeoutMinutes}
          />
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

      {/* ── Audit Timeline ───────────────────────────────────────────────────── */}
      <AuditTimeline taskId={id} />

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
