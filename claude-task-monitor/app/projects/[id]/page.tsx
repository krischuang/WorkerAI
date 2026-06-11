"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
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
import { SCAN_MAX_CONSECUTIVE_FAILURES } from "@/lib/constants";
import { CreateFromTemplateModal } from "@/app/_components/CreateFromTemplateModal";
import { DebtRegister } from "@/app/_components/DebtRegister";
import { SuggestionsTab } from "@/app/_components/SuggestionsTab";
import { DependencyGraph } from "@/app/_components/DependencyGraph";

interface AuditEvent {
  id: string;
  entityId: string;
  eventType: string;
  actorType: string;
  createdAt: string;
}

const EVENT_LABEL: Record<string, string> = {
  "task.created":           "Task created",
  "task.queued":            "Task queued",
  "task.dispatched":        "Task dispatched",
  "task.completed":         "Task completed",
  "task.failed":            "Task failed",
  "task.timeout":           "Task timed out",
  "task.retried":           "Task retried",
  "task.review.sent":       "Review sent",
  "task.review.done":       "Review done",
  "task.review.incomplete": "Review incomplete",
};

const EVENT_DOT: Record<string, string> = {
  "task.completed":         "bg-green-500",
  "task.failed":            "bg-red-500",
  "task.timeout":           "bg-red-400",
  "task.dispatched":        "bg-blue-500",
  "task.queued":            "bg-violet-500",
  "task.created":           "bg-zinc-400",
  "task.review.done":       "bg-emerald-500",
  "task.review.incomplete": "bg-amber-500",
};

function ProjectActivityFeed({ projectId, taskIds }: { projectId: string; taskIds: string[] }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Fetch events for all tasks in the project by querying per-task and merging.
  // For small projects this is fine; for large projects a project-scoped audit index
  // would be needed.
  function load(cursor?: string) {
    // Use entityType=task filter then filter client-side to this project's tasks.
    const url = `/api/audit?entityType=task${cursor ? `&cursor=${cursor}` : ""}`;
    return fetch(url)
      .then((r) => r.json())
      .then((data: { events: AuditEvent[]; nextCursor: string | null }) => {
        const filtered = data.events.filter((e) => taskIds.includes(e.entityId));
        setEvents((prev) => cursor ? [...prev, ...filtered] : filtered);
        setNextCursor(data.nextCursor);
      });
  }

  useEffect(() => {
    if (taskIds.length === 0) return;
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskIds.join(",")]);

  if (events.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Recent Activity</h2>
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
        <ol className="relative border-l border-zinc-200 dark:border-zinc-700 ml-2 space-y-3">
          {events.slice(0, 20).map((ev) => (
            <li key={ev.id} className="pl-5">
              <span className={`absolute left-[-4.5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white ${EVENT_DOT[ev.eventType] ?? "bg-zinc-300"}`} />
              <p className="text-sm text-zinc-900 dark:text-zinc-100">
                {EVENT_LABEL[ev.eventType] ?? ev.eventType}
              </p>
              <p className="text-xs text-zinc-500">
                {new Date(ev.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ol>
        {nextCursor && (
          <div className="mt-4 text-center">
            <Btn variant="ghost" size="sm" onClick={() => { setLoadingMore(true); load(nextCursor).finally(() => setLoadingMore(false)); }} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Btn>
          </div>
        )}
      </div>
    </section>
  );
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  taskType: string;
  estimatedCostLevel: string;
  createdAt: string;
  _count: { executionLogs: number };
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  priority: string;
  status: string;
  tasks: Task[];
  completionPct: number | null;
  totalTasks: number | null;
  completedTasks: number | null;
  failedTasks: number | null;
  runningTasks: number | null;
  pendingTasks: number | null;
  progressUpdatedAt: string | null;
  estimatedCompletionAt: string | null;
  improvementAutomationLevel: number;
  cycleFrequencyDays: number;
  nextImprovementCycleAt: string | null;
  autoImprovementPaused: boolean;
  scanFailureCount: number;
}

interface ScanHealth {
  id: string;
  status: string;
  startedAt: string;
  durationMs: number;
  errorMessage: string | null;
  isStuck: boolean;
}

interface CycleHealth {
  activeCycle: {
    id: string;
    status: string;
    startedAt: string;
    durationMs: number;
    cycleError: string | null;
    isStuck: boolean;
    suggestionsGenerated: number;
  } | null;
  activeScan: ScanHealth | null;
  scanFailureCount: number;
  autoImprovementPaused: boolean;
  isStuck: boolean;
  stuckReason: string | null;
  pendingSuggestionsCount: number;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function CycleHealthPanel({
  projectId,
  automationLevel,
  onProjectRefresh,
}: {
  projectId: string;
  automationLevel: number;
  onProjectRefresh: () => void;
}) {
  const [health, setHealth] = useState<CycleHealth | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [approving, setApproving] = useState(false);
  const [cancellingCycle, setCancellingCycle] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchHealth = useCallback(() => {
    setLoadingHealth(true);
    fetch(`/api/projects/${projectId}/improvement/recover`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: CycleHealth | null) => { if (data) setHealth(data); })
      .catch(() => {})
      .finally(() => setLoadingHealth(false));
  }, [projectId]);

  useEffect(() => { fetchHealth(); }, [fetchHealth]);

  async function handleRecover() {
    setShowConfirm(false);
    setRecovering(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/improvement/recover`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setActionError(data.error ?? "Recovery failed");
    } catch {
      setActionError("Network error during recovery");
    } finally {
      setRecovering(false);
      fetchHealth();
      onProjectRefresh();
    }
  }

  async function handleResume() {
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetImprovementPause: true }),
      });
    } catch { /* ignore */ }
    fetchHealth();
    onProjectRefresh();
  }

  async function handleTrigger() {
    setTriggering(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/trigger-cycle`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setActionError(data.error ?? "Could not start cycle");
    } catch {
      setActionError("Network error");
    } finally {
      setTriggering(false);
      fetchHealth();
      onProjectRefresh();
    }
  }

  async function handleApproveCycle() {
    if (!health?.activeCycle) return;
    setApproving(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/improvement-cycles/${health.activeCycle.id}/approve`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setActionError(data.error ?? "Approval failed");
    } catch {
      setActionError("Network error during approval");
    } finally {
      setApproving(false);
      fetchHealth();
      onProjectRefresh();
    }
  }

  async function handleCancelCycle() {
    if (!health?.activeCycle) return;
    setShowCancelConfirm(false);
    setCancellingCycle(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/improvement-cycles/${health.activeCycle.id}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setActionError(data.error ?? "Cancel failed");
    } catch {
      setActionError("Network error during cancel");
    } finally {
      setCancellingCycle(false);
      fetchHealth();
      onProjectRefresh();
    }
  }

  if (loadingHealth && !health) return null;

  const canTrigger = !health?.activeCycle && !health?.autoImprovementPaused && automationLevel >= 1;

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 mb-6 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800">
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide">
          Improvement Cycle
        </span>
        <button
          onClick={fetchHealth}
          disabled={loadingHealth}
          className="p-1 rounded text-zinc-400 hover:text-zinc-600 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-3 h-3 ${loadingHealth ? "animate-spin" : ""}`} />
        </button>
      </div>

      {health?.activeCycle?.status === "awaiting_approval" && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-100 dark:border-amber-800/30">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {(health.pendingSuggestionsCount ?? 0) > 0
              ? `Cycle is waiting for your approval. Review ${health.pendingSuggestionsCount} pending suggestion${health.pendingSuggestionsCount !== 1 ? "s" : ""} in the Suggestions tab, then approve below.`
              : "Cycle is waiting for approval but there are no suggestions to review. Approve to complete the cycle without changes, or cancel it."}
          </p>
        </div>
      )}

      {health?.autoImprovementPaused && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-100 dark:border-amber-800/30">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Auto-improvement paused after {health.scanFailureCount} consecutive scan failure{health.scanFailureCount !== 1 ? "s" : ""}. Resolve the underlying issue, then resume.
          </p>
        </div>
      )}

      {health?.isStuck && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 dark:bg-red-950/20 border-b border-red-100 dark:border-red-800/30">
          <AlertTriangle className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" />
          <p className="text-xs text-red-800 dark:text-red-300">{health.stuckReason}</p>
        </div>
      )}

      <div className="px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <dt className="text-zinc-500">Cycle status</dt>
          <dd className="text-zinc-900 dark:text-zinc-100 font-medium">
            {health?.activeCycle ? (
              <span className={health.activeCycle.isStuck ? "text-red-700" : ""}>
                {health.activeCycle.status}
                {health.activeCycle.isStuck && " ⚠ stuck"}
              </span>
            ) : (
              <span className="text-zinc-400">none</span>
            )}
          </dd>

          <dt className="text-zinc-500">Scan status</dt>
          <dd className="text-zinc-900 dark:text-zinc-100 font-medium">
            {health?.activeScan ? (
              <span className={health.activeScan.isStuck ? "text-red-700" : ""}>
                {health.activeScan.status}
                {health.activeScan.isStuck && " ⚠ stuck"}
              </span>
            ) : (
              <span className="text-zinc-400">none</span>
            )}
          </dd>

          {health?.activeCycle && (
            <>
              <dt className="text-zinc-500">Running for</dt>
              <dd className="text-zinc-900 dark:text-zinc-100">
                {formatDuration(health.activeCycle.durationMs)}
              </dd>
            </>
          )}

          <dt className="text-zinc-500">Scan failures</dt>
          <dd className={`font-medium ${(health?.scanFailureCount ?? 0) >= SCAN_MAX_CONSECUTIVE_FAILURES ? "text-red-700" : "text-zinc-900 dark:text-zinc-100"}`}>
            {health?.scanFailureCount ?? 0} / {SCAN_MAX_CONSECUTIVE_FAILURES}
          </dd>

          {(health?.activeCycle?.cycleError ?? health?.activeScan?.errorMessage) && (
            <>
              <dt className="text-zinc-500">Last error</dt>
              <dd className="text-zinc-700 dark:text-zinc-300 font-mono text-[11px] truncate max-w-xs">
                {health?.activeCycle?.cycleError ?? health?.activeScan?.errorMessage}
              </dd>
            </>
          )}
        </dl>

        {actionError && (
          <p className="mt-2 text-xs text-red-700">{actionError}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {health?.activeCycle?.status === "awaiting_approval" && (
            <>
              <Btn variant="primary" size="sm" onClick={handleApproveCycle} disabled={approving || cancellingCycle}>
                {approving ? "Approving…" : "Approve cycle"}
              </Btn>
              <Btn variant="secondary" size="sm" onClick={() => setShowCancelConfirm(true)} disabled={approving || cancellingCycle}>
                Cancel cycle
              </Btn>
            </>
          )}
          {health?.isStuck && (
            <Btn variant="danger" size="sm" onClick={() => setShowConfirm(true)} disabled={recovering}>
              {recovering ? "Recovering…" : "Recover stuck scan"}
            </Btn>
          )}
          {health?.autoImprovementPaused && (
            <Btn variant="secondary" size="sm" onClick={handleResume}>
              Resume auto-improvement
            </Btn>
          )}
          {canTrigger && (
            <Btn variant="ghost" size="sm" onClick={handleTrigger} disabled={triggering}>
              {triggering ? "Starting…" : "Run scan now"}
            </Btn>
          )}
        </div>
      </div>

      {showConfirm && (
        <Modal title="Recover stuck scan?" onClose={() => setShowConfirm(false)} size="md">
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1">
            This will mark the stuck scan and improvement cycle as <strong>failed</strong>,
            increment the scan failure counter, and allow a new cycle to start.
          </p>
          {health?.stuckReason && (
            <p className="text-xs text-zinc-500 font-mono">{health.stuckReason}</p>
          )}
          <ModalActions>
            <Btn variant="ghost" size="sm" onClick={() => setShowConfirm(false)}>Cancel</Btn>
            <Btn variant="danger" size="sm" onClick={handleRecover}>Confirm recovery</Btn>
          </ModalActions>
        </Modal>
      )}

      {showCancelConfirm && (
        <Modal title="Cancel improvement cycle?" onClose={() => setShowCancelConfirm(false)} size="md">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            This will cancel the current cycle. No tasks will be created. A new cycle can be started manually or will run on the next scheduled interval.
          </p>
          <ModalActions>
            <Btn variant="ghost" size="sm" onClick={() => setShowCancelConfirm(false)}>Keep waiting</Btn>
            <Btn variant="danger" size="sm" onClick={handleCancelCycle} disabled={cancellingCycle}>
              {cancellingCycle ? "Cancelling…" : "Cancel cycle"}
            </Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

const AUTOMATION_LEVELS = [
  {
    label: "Disabled",
    description: "No automatic improvement cycles.",
    detail: "Improvement cycles must be triggered manually via the API.",
  },
  {
    label: "Semi-auto",
    description: "Scan + detect + suggest, pauses for approval.",
    detail: "The engine runs the scan and generates suggestions automatically, but waits for a human to review and approve each suggestion before applying it. Recommended starting point.",
  },
  {
    label: "Assisted",
    description: "Auto-approves low-severity suggestions.",
    detail: "Low-severity suggestions (style, documentation) are applied automatically. High-severity changes still require approval.",
  },
  {
    label: "Fully autonomous",
    description: "Auto-approves all suggestions.",
    detail: "All suggestions are applied without human review. Blocked when the assigned agent is in read_only permission mode.",
  },
];

const PRIORITIES = ["P1", "P2", "P3", "P4"];
const TASK_TYPES = ["coding", "research", "writing", "review", "maintenance"];
const COST_LEVELS = ["low", "medium", "high"];

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<"tasks" | "graph" | "debt" | "suggestions">("tasks");
  const [pendingSuggestionCount, setPendingSuggestionCount] = useState<number | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<{ id: string; title: string } | null>(null);
  const [deletingTask, setDeletingTask] = useState(false);
  const [showAutomationModal, setShowAutomationModal] = useState(false);
  const [pendingLevel, setPendingLevel] = useState<number | null>(null);
  const [savingLevel, setSavingLevel] = useState(false);
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "medium",
  });

  const loadProject = useCallback(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => {
        if (!r.ok) { router.push("/projects"); return null; }
        return r.json();
      })
      .then((data) => { if (data) setProject(data); });
  }, [id, router]);

  useEffect(() => {
    loadProject();
    fetch(`/api/projects/${id}/suggestions`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: { status: string }[]) => {
        setPendingSuggestionCount(data.filter((s) => s.status === "pending_review").length);
      });
  }, [id, loadProject]);

  async function handleRecalculate() {
    setRecalculating(true);
    await fetch(`/api/projects/${id}/recalculate`, { method: "POST" }).catch(() => {});
    setRecalculating(false);
    loadProject();
  }

  function openCreateTask() {
    setEditTask(null);
    setTaskForm({ title: "", description: "", priority: "P3", taskType: "coding", estimatedCostLevel: "medium" });
    setShowTaskForm(true);
  }

  function openEditTask(t: Task) {
    setEditTask(t);
    setTaskForm({
      title: t.title,
      description: t.description ?? "",
      priority: t.priority,
      taskType: t.taskType,
      estimatedCostLevel: t.estimatedCostLevel,
    });
    setShowTaskForm(true);
  }

  async function handleTaskSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editTask) {
      await fetch(`/api/tasks/${editTask.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskForm),
      });
    } else {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id, ...taskForm }),
      });
    }
    setShowTaskForm(false);
    loadProject();
  }

  async function doDeleteTask() {
    if (!confirmDeleteTask) return;
    setDeletingTask(true);
    await fetch(`/api/tasks/${confirmDeleteTask.id}`, { method: "DELETE" });
    setDeletingTask(false);
    setConfirmDeleteTask(null);
    loadProject();
  }

  async function handleSaveAutomationLevel() {
    if (pendingLevel === null) return;
    setSavingLevel(true);
    await fetch(`/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ improvementAutomationLevel: pendingLevel }),
    });
    setSavingLevel(false);
    setShowAutomationModal(false);
    setPendingLevel(null);
    loadProject();
  }

  if (!project) return <LoadingState />;

  return (
    <div className="p-8 max-w-5xl">
      <BackLink href="/projects" label="Projects" />

      <div className="flex items-start justify-between gap-4 mb-8 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{project.name}</h1>
          {project.description && (
            <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <PriorityBadge priority={project.priority} />
          <StatusBadge status={project.status} />
          <button
            onClick={() => { setPendingLevel(project.improvementAutomationLevel); setShowAutomationModal(true); }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:bg-zinc-950 border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300"
            title="Click to change automation level"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${project.improvementAutomationLevel === 0 ? "bg-zinc-400" : project.improvementAutomationLevel === 1 ? "bg-blue-500" : project.improvementAutomationLevel === 2 ? "bg-amber-500" : "bg-green-500"}`} />
            Auto L{project.improvementAutomationLevel}
          </button>
        </div>
      </div>

      {/* ── Progress ───────────────────────────────────────────────────────── */}
      {project.totalTasks !== null && project.totalTasks > 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Progress — {Math.round(project.completionPct ?? 0)}%
            </span>
            <div className="flex items-center gap-3 text-xs text-zinc-600 dark:text-zinc-400">
              {project.runningTasks !== null && project.runningTasks > 0 && (
                <span className="text-blue-700">{project.runningTasks} running</span>
              )}
              {project.failedTasks !== null && project.failedTasks > 0 && (
                <span className="text-red-700">{project.failedTasks} failed</span>
              )}
              <span>{project.completedTasks ?? 0}/{project.totalTasks} done</span>
            </div>
          </div>
          <div className="w-full h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all"
              style={{ width: `${Math.min(project.completionPct ?? 0, 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1.5">
            {project.estimatedCompletionAt ? (
              <p className="text-xs text-zinc-500">
                ETA: {new Date(project.estimatedCompletionAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </p>
            ) : <span />}
            <Btn variant="ghost" size="sm" onClick={handleRecalculate} disabled={recalculating}>
              {recalculating ? "Recalculating…" : "Recalculate"}
            </Btn>
          </div>
        </div>
      )}

      {/* ── Improvement Cycle Health ────────────────────────────────────── */}
      {(project.improvementAutomationLevel >= 1 || project.autoImprovementPaused) && (
        <CycleHealthPanel
          projectId={id}
          automationLevel={project.improvementAutomationLevel}
          onProjectRefresh={loadProject}
        />
      )}

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 mb-4 border-b border-zinc-200 dark:border-zinc-700">
        {(["tasks", "graph", "debt", "suggestions"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors rounded-t-md -mb-px border-b-2 flex items-center gap-1.5 ${
              activeTab === tab
                ? "border-zinc-900 text-zinc-900 dark:text-zinc-100"
                : "border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:text-zinc-100"
            }`}
          >
            {tab === "tasks"
              ? `Tasks (${project.tasks.length})`
              : tab === "graph"
              ? "Dependency Graph"
              : tab === "debt"
              ? "Debt Register"
              : (
                <>
                  Suggestions
                  {pendingSuggestionCount != null && pendingSuggestionCount > 0 && (
                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-white text-[10px] font-bold leading-none">
                      {pendingSuggestionCount > 9 ? "9+" : pendingSuggestionCount}
                    </span>
                  )}
                </>
              )
            }
          </button>
        ))}
      </div>

      {/* ── Tasks tab ───────────────────────────────────────────────────── */}
      {activeTab === "tasks" && (
        <>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">
              Tasks ({project.tasks.length})
            </h2>
            <div className="flex items-center gap-2">
              <Btn variant="secondary" onClick={() => setShowTemplateModal(true)}>
                From Template
              </Btn>
              <Btn variant="primary" onClick={openCreateTask}>
                + Add Task
              </Btn>
            </div>
          </div>

          {project.tasks.length === 0 ? (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-8 text-center">
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">No tasks yet.</p>
              <Btn variant="primary" onClick={openCreateTask}>Add first task</Btn>
            </div>
          ) : (
            <div className="space-y-2">
              {project.tasks.map((t) => (
                <div
                  key={t.id}
                  className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 flex items-center gap-4 hover:border-zinc-300 dark:border-zinc-600 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/tasks/${t.id}`}
                      className="font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                    >
                      {t.title}
                    </Link>
                    <div className="flex items-center gap-3 mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                      <span>{t.taskType}</span>
                      <span>cost: {t.estimatedCostLevel}</span>
                      <span>{t._count.executionLogs} logs</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <PriorityBadge priority={t.priority} />
                    <StatusBadge status={t.status} />
                  </div>
                  <div className="flex gap-3 shrink-0">
                    <button
                      onClick={() => openEditTask(t)}
                      className="text-xs text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:text-zinc-100 font-medium transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmDeleteTask({ id: t.id, title: t.title })}
                      className="text-xs text-red-700 hover:text-red-900 font-medium transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <ProjectActivityFeed
            projectId={id}
            taskIds={project.tasks.map((t) => t.id)}
          />
        </>
      )}

      {/* ── Dependency Graph tab ────────────────────────────────────────── */}
      {activeTab === "graph" && (
        <DependencyGraph projectId={id} />
      )}

      {/* ── Debt Register tab ───────────────────────────────────────────── */}
      {activeTab === "debt" && (
        <DebtRegister projectId={id} />
      )}

      {/* ── Suggestions tab ─────────────────────────────────────────────── */}
      {activeTab === "suggestions" && (
        <SuggestionsTab projectId={id} />
      )}

      {/* ── Modals (always mounted so state is preserved across tab switches) */}
      {showTaskForm && (
        <Modal
          title={editTask ? "Edit Task" : "New Task"}
          onClose={() => setShowTaskForm(false)}
          size="lg"
        >
          <form onSubmit={handleTaskSubmit} className="space-y-4">
            <FormField label="Title" required>
              <input
                required
                value={taskForm.title}
                onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                placeholder="e.g. Build tarot card generator"
                className={inputCls}
              />
            </FormField>
            <FormField label="Description">
              <textarea
                value={taskForm.description}
                onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })}
                rows={3}
                placeholder="Details about this task…"
                className={inputCls}
              />
            </FormField>
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Priority">
                <select
                  value={taskForm.priority}
                  onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}
                  className={inputCls}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Type">
                <select
                  value={taskForm.taskType}
                  onChange={(e) => setTaskForm({ ...taskForm, taskType: e.target.value })}
                  className={inputCls}
                >
                  {TASK_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Cost">
                <select
                  value={taskForm.estimatedCostLevel}
                  onChange={(e) => setTaskForm({ ...taskForm, estimatedCostLevel: e.target.value })}
                  className={inputCls}
                >
                  {COST_LEVELS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <ModalActions>
              <Btn type="submit" variant="primary" className="flex-1">
                {editTask ? "Save Changes" : "Create Task"}
              </Btn>
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => setShowTaskForm(false)}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {confirmDeleteTask && (
        <Modal title="Delete Task" onClose={() => setConfirmDeleteTask(null)}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1">
            Delete task <strong>{confirmDeleteTask.title}</strong>?
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            All execution logs for this task will be permanently deleted.
            This cannot be undone.
          </p>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setConfirmDeleteTask(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={doDeleteTask} disabled={deletingTask}>
              {deletingTask ? "Deleting…" : "Delete Task"}
            </Btn>
          </ModalActions>
        </Modal>
      )}

      {showTemplateModal && (
        <CreateFromTemplateModal
          projectId={id}
          onClose={() => setShowTemplateModal(false)}
          onCreated={() => { setShowTemplateModal(false); loadProject(); }}
        />
      )}

      {showAutomationModal && pendingLevel !== null && (
        <Modal
          title="Improvement Cycle Automation"
          onClose={() => { setShowAutomationModal(false); setPendingLevel(null); }}
          size="lg"
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Choose how automatically the improvement cycle engine operates for this project.
          </p>
          <div className="space-y-2 mb-4">
            {AUTOMATION_LEVELS.map((lvl, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPendingLevel(i)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${
                  pendingLevel === i
                    ? "border-zinc-900 bg-zinc-50 dark:bg-zinc-950 ring-1 ring-zinc-900"
                    : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:bg-zinc-950"
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${i === 0 ? "bg-zinc-400" : i === 1 ? "bg-blue-500" : i === 2 ? "bg-amber-500" : "bg-green-500"}`} />
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Level {i} — {lvl.label}</span>
                  {i === 1 && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200">Recommended</span>}
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 pl-4">{lvl.description}</p>
                {pendingLevel === i && (
                  <p className="text-xs text-zinc-500 mt-1.5 pl-4">{lvl.detail}</p>
                )}
              </button>
            ))}
          </div>
          {pendingLevel > 0 && (
            <div className="mb-4 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
              Next cycle in ~{project.cycleFrequencyDays} day{project.cycleFrequencyDays === 1 ? "" : "s"}
              {project.nextImprovementCycleAt && (
                <> · scheduled {new Date(project.nextImprovementCycleAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</>
              )}
            </div>
          )}
          <ModalActions>
            <Btn
              variant="primary"
              className="flex-1"
              onClick={handleSaveAutomationLevel}
              disabled={savingLevel || pendingLevel === project.improvementAutomationLevel}
            >
              {savingLevel ? "Saving…" : "Save"}
            </Btn>
            <Btn
              variant="secondary"
              className="flex-1"
              onClick={() => { setShowAutomationModal(false); setPendingLevel(null); }}
            >
              Cancel
            </Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}
