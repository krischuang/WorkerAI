"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Clock } from "lucide-react";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import { TaskDetailPanel } from "@/app/_components/TaskDetailPanel";
import { CreateFromTemplateModal } from "@/app/_components/CreateFromTemplateModal";
import {
  PageHeader,
  EmptyState,
  LoadingState,
  Modal,
  Btn,
  ModalActions,
  FormField,
  inputCls,
} from "@/app/_components/ui";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  priority: string;
}

interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  taskType: string;
  estimatedCostLevel: string;
  createdAt: string;
  scheduledFor: string | null;
  project: { name: string; priority: string };
  _count: { executionLogs: number };
  executionLogs: { startedAt: string; finishedAt: string | null; actualCostUsd: number | null }[];
}

interface ServerOption {
  id: string;
  name: string;
  host: string;
}

interface AgentOption {
  id: string;
  name: string;
  server: { name: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

function formatScheduled(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric", minute: "2-digit",
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIORITIES = ["P1", "P2", "P3", "P4"];
const TASK_TYPES = ["coding", "research", "writing", "review", "maintenance"];
const COST_LEVELS = ["low", "medium", "high"];
const STATUS_FILTERS = ["all", "pending", "queued", "running", "completed", "failed"] as const;

const defaultForm = {
  projectId: "",
  title: "",
  description: "",
  priority: "P3",
  taskType: "coding",
  estimatedCostLevel: "medium",
};

// ── Page component ────────────────────────────────────────────────────────────

export default function TasksPage() {
  return (
    <Suspense fallback={<div className="p-4 md:p-8 text-sm text-zinc-500">Loading…</div>}>
      <TasksPageInner />
    </Suspense>
  );
}

const PAGE_SIZE = 50;

function TasksPageInner() {
  const searchParams = useSearchParams();
  const [tasks,          setTasks]          = useState<Task[]>([]);
  const [total,          setTotal]          = useState(0);
  const [totalCompleted, setTotalCompleted] = useState(0);
  const [page,           setPage]           = useState(1);
  const [projects,       setProjects]       = useState<Project[]>([]);
  const [servers,        setServers]        = useState<ServerOption[]>([]);
  const [agents,         setAgents]         = useState<AgentOption[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [statusFilter,   setStatusFilter]   = useState("all");
  const [projectFilter,  setProjectFilter]  = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    searchParams.get("highlight"),
  );
  const [showForm,           setShowForm]           = useState(false);
  const [showTemplateModal,  setShowTemplateModal]  = useState(false);
  const [templateProjectId,  setTemplateProjectId]  = useState<string>("");
  const [form,               setForm]               = useState(defaultForm);
  const [submitting,         setSubmitting]         = useState(false);
  const [clearing,           setClearing]           = useState(false);
  const [showExportModal,    setShowExportModal]    = useState(false);
  const [exportFormat,       setExportFormat]       = useState<"csv" | "json">("csv");
  const [exportStatus,       setExportStatus]       = useState("all");
  const [exportProject,      setExportProject]      = useState("all");
  const [refreshKey,         setRefreshKey]         = useState(0);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ── Bulk selection state ────────────────────────────────────────────────────
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set());
  const [bulkLoading,  setBulkLoading]  = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  // ── J/K/Enter list navigation cursor ──────────────────────────────────────
  const [cursor, setCursor] = useState<number>(-1);
  // Ref keeps the current task list available to the keyboard handler.
  const filteredTasksRef = useRef<Task[]>([]);

  // ── Data loading ────────────────────────────────────────────────────────────

  // Tasks — server-side filtered and paginated
  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (projectFilter !== "all") params.set("projectId", projectFilter);

    fetch(`/api/tasks?${params}`)
      .then((r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (!data) return;
        setTasks(data.tasks);
        setTotal(data.total);
        setTotalCompleted(data.completedCount ?? 0);
        setLoading(false);
      });
  }, [page, statusFilter, projectFilter, refreshKey]);

  function loadTasks() { setRefreshKey((k) => k + 1); }

  function loadProjects() {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: Project[]) => {
        setProjects(data);
        if (data.length > 0) setForm((f) => ({ ...f, projectId: f.projectId || data[0].id }));
      });
  }

  function loadServers() {
    fetch("/api/servers")
      .then((r) => r.json())
      .then((data: ServerOption[]) => setServers(data))
      .catch(() => {});
  }

  function loadAgents() {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data: AgentOption[]) => setAgents(data))
      .catch(() => {});
  }

  useEffect(() => {
    loadProjects();
    loadServers();
    loadAgents();
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  // N = open new task form (broadcast from GlobalKeyboardShortcuts)
  useEffect(() => {
    function onNewTask() { setShowForm(true); }
    window.addEventListener("workerai:new-task", onNewTask);
    return () => window.removeEventListener("workerai:new-task", onNewTask);
  }, []);

  // J / K = move cursor, Enter = open detail
  // Uses refs so filteredTasks (declared later) doesn't need to be in deps.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const showFormRef = useRef(showForm);
  showFormRef.current = showForm;
  const showExportRef = useRef(showExportModal);
  showExportRef.current = showExportModal;
  const showTemplateRef = useRef(showTemplateModal);
  showTemplateRef.current = showTemplateModal;

  const handleListNav = useCallback((e: KeyboardEvent) => {
    if (showFormRef.current || showExportRef.current || showTemplateRef.current) return;
    const tasks = filteredTasksRef.current;
    if (e.key === "j" || e.key === "J") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, tasks.length - 1));
    } else if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && cursorRef.current >= 0 && cursorRef.current < tasks.length) {
      e.preventDefault();
      setSelectedTaskId(tasks[cursorRef.current].id);
    }
  }, []);

  useKeyboardShortcut(handleListNav, [handleListNav]);

  // ── Filtering ───────────────────────────────────────────────────────────────

  // Filtering is server-side — tasks already reflects the active filters.
  // Keep ref in sync so keyboard handler can access current list.
  filteredTasksRef.current = tasks;

  // Sync the indeterminate state on the select-all checkbox
  useEffect(() => {
    const el = selectAllRef.current;
    if (!el || tasks.length === 0) return;
    const selectedCount = tasks.filter((t) => selectedIds.has(t.id)).length;
    el.indeterminate = selectedCount > 0 && selectedCount < tasks.length;
  });

  // ── Selection helpers ───────────────────────────────────────────────────────

  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const visibleIds = tasks.map((t) => t.id);
    const allSelected = visibleIds.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
  }

  // ── Bulk action ─────────────────────────────────────────────────────────────

  async function handleBulkAction(
    action: "assign_server" | "assign_agent" | "mark_completed" | "archive",
    payload?: { serverId?: string; agentId?: string },
  ) {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    await fetch("/api/tasks/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(selectedIds), action, payload }),
    });
    setBulkLoading(false);
    setSelectedIds(new Set());
    loadTasks();
  }

  // ── Regular actions ─────────────────────────────────────────────────────────

  function handleFilterChange(status: string) {
    setStatusFilter(status);
    setPage(1);
    setSelectedIds(new Set());
    setCursor(-1);
  }

  function handleProjectFilterChange(project: string) {
    setProjectFilter(project);
    setPage(1);
    setSelectedIds(new Set());
    setCursor(-1);
  }

  function goToPage(p: number) {
    setPage(p);
    setSelectedIds(new Set());
    setCursor(-1);
  }

  function openForm() {
    setForm({ ...defaultForm, projectId: projects[0]?.id ?? "" });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSubmitting(false);
    setShowForm(false);
    loadTasks();
  }

  async function clearCompleted() {
    if (totalCompleted === 0) return;
    if (!confirm(`Delete all ${totalCompleted} completed task${totalCompleted !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    setClearing(true);
    await fetch("/api/tasks?status=completed", { method: "DELETE" });
    setClearing(false);
    setPage(1);
    loadTasks();
  }

  function openExportModal() {
    setExportStatus(statusFilter);
    setExportProject(projectFilter);
    setShowExportModal(true);
  }

  function handleExportDownload() {
    const params = new URLSearchParams({ format: exportFormat });
    if (exportStatus  && exportStatus  !== "all") params.set("status",    exportStatus);
    if (exportProject && exportProject !== "all") params.set("projectId", exportProject);
    const a = document.createElement("a");
    a.href = `/api/tasks/export?${params.toString()}`;
    a.download = "";
    a.click();
    setShowExportModal(false);
  }

  // ── Derived selection state ─────────────────────────────────────────────────

  const visibleSelectedCount = tasks.filter((t) => selectedIds.has(t.id)).length;
  const allVisibleSelected   = tasks.length > 0 && visibleSelectedCount === tasks.length;

  if (loading) return <LoadingState />;

  return (
    <div className="p-4 md:p-8 max-w-5xl pb-32">
      <PageHeader
        title="Tasks"
        subtitle="All tasks across every project"
        action={
          <div className="flex gap-2 flex-wrap justify-end">
            {totalCompleted > 0 && (
              <Btn variant="secondary" onClick={clearCompleted} disabled={clearing}>
                {clearing ? "Clearing…" : "Clear completed"}
              </Btn>
            )}
            <Btn variant="secondary" onClick={openExportModal} disabled={total === 0}>
              Export
            </Btn>
            <Btn
              variant="secondary"
              onClick={() => {
                setTemplateProjectId(projects.length === 1 ? projects[0].id : "");
                setShowTemplateModal(true);
              }}
              disabled={projects.length === 0}
              className="hidden sm:inline-flex"
            >
              From Template
            </Btn>
            <Btn variant="primary" onClick={openForm} disabled={projects.length === 0}>
              + New Task
            </Btn>
          </div>
        }
      />

      {/* ── Filters + select-all ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div className="flex items-center gap-3">
          {/* Select-all checkbox */}
          {tasks.length > 0 && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Select all visible tasks">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
                className="w-4 h-4 rounded accent-zinc-900"
              />
              <span className="text-xs text-zinc-500 hidden sm:inline">All</span>
            </label>
          )}

          <div className="flex gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg flex-wrap">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => handleFilterChange(s)}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-all capitalize ${
                  statusFilter === s
                    ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {projects.length > 0 && (
          <select
            value={projectFilter}
            onChange={(e) => handleProjectFilterChange(e.target.value)}
            className="text-sm border border-zinc-300 dark:border-zinc-600 rounded-lg px-3 py-1.5 text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 shadow-sm"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* ── Task list ─────────────────────────────────────────────────────── */}
      {tasks.length === 0 ? (
        <EmptyState
          message={
            statusFilter !== "all" || projectFilter !== "all"
              ? "No tasks match the selected filters."
              : "Create your first task to get started."
          }
        />
      ) : (
        <div className="space-y-1.5">
          {tasks.map((task, idx) => {
            const isSelected = selectedIds.has(task.id);
            const isCursor = cursor === idx;
            return (
              <div
                key={task.id}
                className={`flex items-center gap-3 bg-white dark:bg-zinc-900 border rounded-xl px-4 py-3.5 transition-all ${
                  isSelected
                    ? "border-blue-300 bg-blue-50 shadow-sm"
                    : isCursor
                    ? "border-violet-400 ring-1 ring-violet-400 shadow-sm"
                    : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:border-zinc-600 hover:shadow-sm"
                }`}
              >
                {/* Checkbox — stops propagation so clicking it doesn't open the detail */}
                <label
                  className="flex items-center cursor-pointer shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelection(task.id)}
                    className="w-4 h-4 rounded accent-zinc-900"
                  />
                </label>

                {/* Main row content — opens task detail */}
                <button
                  className="flex-1 text-left min-w-0 group"
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate group-hover:text-blue-700 transition-colors">
                        {task.title}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5 text-xs text-zinc-500 flex-wrap">
                        <span>{task.project.name}</span>
                        <span>·</span>
                        <span className="capitalize">{task.taskType}</span>
                        {task._count.executionLogs > 0 && (
                          <>
                            <span>·</span>
                            <span>{task._count.executionLogs} run{task._count.executionLogs !== 1 ? "s" : ""}</span>
                          </>
                        )}
                        {task.executionLogs[0] && (
                          <>
                            <span>·</span>
                            <span>Last run {timeAgo(task.executionLogs[0].startedAt)}</span>
                          </>
                        )}
                        {task.status === "completed" && task.executionLogs[0]?.actualCostUsd != null && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono bg-violet-50 text-violet-700 border border-violet-200">
                            ${task.executionLogs[0].actualCostUsd < 0.01
                              ? task.executionLogs[0].actualCostUsd.toFixed(4)
                              : task.executionLogs[0].actualCostUsd.toFixed(2)}
                          </span>
                        )}
                        {task.scheduledFor && (
                          <span className="inline-flex items-center gap-0.5 text-blue-600 font-medium">
                            <Clock className="w-3 h-3" />
                            {formatScheduled(task.scheduledFor)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <PriorityBadge priority={task.priority} />
                      <StatusBadge status={task.status} />
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Pagination ────────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-6 pt-4 border-t border-zinc-200 dark:border-zinc-700">
          <p className="text-sm text-zinc-500">
            {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} task{total !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-2">
            <Btn
              variant="secondary"
              size="sm"
              disabled={page === 1}
              onClick={() => goToPage(page - 1)}
            >
              ← Prev
            </Btn>
            <span className="text-sm text-zinc-600 px-1">
              {page} / {totalPages}
            </span>
            <Btn
              variant="secondary"
              size="sm"
              disabled={page === totalPages}
              onClick={() => goToPage(page + 1)}
            >
              Next →
            </Btn>
          </div>
        </div>
      )}

      {/* ── Bulk action bar (sticky, appears when 1+ rows selected) ──────── */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-zinc-900 text-white rounded-2xl shadow-2xl px-4 py-2.5 border border-zinc-700 max-w-[95vw] overflow-x-auto">
          <span className="text-sm font-semibold text-zinc-200 shrink-0 mr-1">
            {selectedIds.size} selected
          </span>

          <div className="w-px h-5 bg-zinc-600 shrink-0" />

          {/* Assign to Server */}
          {servers.length > 0 && (
            <select
              defaultValue=""
              disabled={bulkLoading}
              onChange={(e) => {
                if (e.target.value) {
                  handleBulkAction("assign_server", { serverId: e.target.value });
                  e.target.value = "";
                }
              }}
              className="text-xs bg-zinc-800 border border-zinc-600 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-500 disabled:opacity-50 shrink-0"
            >
              <option value="">Assign to Server…</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.host})
                </option>
              ))}
            </select>
          )}

          {/* Assign to Agent */}
          {agents.length > 0 && (
            <select
              defaultValue=""
              disabled={bulkLoading}
              onChange={(e) => {
                if (e.target.value) {
                  handleBulkAction("assign_agent", { agentId: e.target.value });
                  e.target.value = "";
                }
              }}
              className="text-xs bg-zinc-800 border border-zinc-600 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-500 disabled:opacity-50 shrink-0"
            >
              <option value="">Assign to Agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.server.name}
                </option>
              ))}
            </select>
          )}

          <div className="w-px h-5 bg-zinc-600 shrink-0" />

          <button
            disabled={bulkLoading}
            onClick={() => handleBulkAction("mark_completed")}
            className="text-xs font-medium text-green-300 hover:text-green-200 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
          >
            {bulkLoading ? "…" : "Mark Completed"}
          </button>

          <button
            disabled={bulkLoading}
            onClick={() => handleBulkAction("archive")}
            className="text-xs font-medium text-zinc-300 hover:text-white px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
          >
            Archive
          </button>

          <div className="w-px h-5 bg-zinc-600 shrink-0" />

          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-xs font-medium text-zinc-400 hover:text-white px-2 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors shrink-0"
            aria-label="Clear selection"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}

      {selectedTaskId && (
        <Modal
          onClose={() => { setSelectedTaskId(null); loadTasks(); }}
          size="xl"
        >
          <TaskDetailPanel
            id={selectedTaskId}
            onClose={() => { setSelectedTaskId(null); loadTasks(); }}
          />
        </Modal>
      )}

      {showForm && (
        <Modal title="New Task" onClose={() => setShowForm(false)} size="lg">
          <form onSubmit={handleSubmit} className="space-y-4">
            <FormField label="Project" required>
              <select
                required
                value={form.projectId}
                onChange={(e) => setForm({ ...form, projectId: e.target.value })}
                className={inputCls}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>[{p.priority}] {p.name}</option>
                ))}
              </select>
            </FormField>

            <FormField label="Title" required>
              <input
                required
                autoFocus
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Build tarot card generator"
                className={inputCls}
              />
            </FormField>

            <FormField label="Description">
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                placeholder="Details about this task…"
                className={inputCls}
              />
            </FormField>

            <div className="grid grid-cols-3 gap-3">
              <FormField label="Priority">
                <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={inputCls}>
                  {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </FormField>
              <FormField label="Type">
                <select value={form.taskType} onChange={(e) => setForm({ ...form, taskType: e.target.value })} className={inputCls}>
                  {TASK_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </FormField>
              <FormField label="Cost">
                <select value={form.estimatedCostLevel} onChange={(e) => setForm({ ...form, estimatedCostLevel: e.target.value })} className={inputCls}>
                  {COST_LEVELS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </FormField>
            </div>

            <ModalActions>
              <Btn type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
              <Btn type="submit" variant="primary" disabled={submitting}>
                {submitting ? "Creating…" : "Create Task"}
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {showTemplateModal && !templateProjectId && (
        <Modal title="Choose Project" onClose={() => setShowTemplateModal(false)}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">Select the project this task belongs to:</p>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => setTemplateProjectId(p.id)}
                className="w-full text-left rounded-lg border border-zinc-200 dark:border-zinc-700 px-4 py-3 hover:border-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:bg-zinc-950 transition-colors text-sm font-medium text-zinc-900 dark:text-zinc-100"
              >
                {p.name}
              </button>
            ))}
          </div>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setShowTemplateModal(false)}>Cancel</Btn>
          </ModalActions>
        </Modal>
      )}

      {showTemplateModal && templateProjectId && (
        <CreateFromTemplateModal
          projectId={templateProjectId}
          onClose={() => { setShowTemplateModal(false); setTemplateProjectId(""); }}
          onCreated={() => { setShowTemplateModal(false); setTemplateProjectId(""); loadTasks(); }}
        />
      )}

      {/* ── Export modal ──────────────────────────────────────────────────── */}
      {showExportModal && (
        <Modal title="Export Tasks" onClose={() => setShowExportModal(false)}>
          <div className="space-y-4">
            <FormField label="Format">
              <div className="flex gap-3 flex-wrap">
                {(["csv", "json"] as const).map((fmt) => (
                  <label key={fmt} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="export-format"
                      value={fmt}
                      checked={exportFormat === fmt}
                      onChange={() => setExportFormat(fmt)}
                      className="accent-zinc-900"
                    />
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 uppercase">{fmt}</span>
                    <span className="text-xs text-zinc-500">
                      {fmt === "csv" ? "— one row per task, last run flattened" : "— tasks with nested executionLogs"}
                    </span>
                  </label>
                ))}
              </div>
            </FormField>

            <FormField label="Status filter">
              <select value={exportStatus} onChange={(e) => setExportStatus(e.target.value)} className={inputCls}>
                <option value="all">All statuses</option>
                {STATUS_FILTERS.filter((s) => s !== "all").map((s) => (
                  <option key={s} value={s} className="capitalize">{s}</option>
                ))}
              </select>
            </FormField>

            {projects.length > 0 && (
              <FormField label="Project filter">
                <select value={exportProject} onChange={(e) => setExportProject(e.target.value)} className={inputCls}>
                  <option value="all">All projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </FormField>
            )}

            <p className="text-xs text-zinc-500">
              Export will include all tasks matching the selected filters.
            </p>
          </div>

          <ModalActions>
            <Btn variant="secondary" onClick={() => setShowExportModal(false)}>Cancel</Btn>
            <Btn variant="primary" onClick={handleExportDownload}>
              Download {exportFormat.toUpperCase()}
            </Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}
