"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
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
import { CreateFromTemplateModal } from "@/app/_components/CreateFromTemplateModal";
import { DebtRegister } from "@/app/_components/DebtRegister";
import { SuggestionsTab } from "@/app/_components/SuggestionsTab";

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
      <h2 className="font-semibold text-zinc-900 mb-3">Recent Activity</h2>
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <ol className="relative border-l border-zinc-200 ml-2 space-y-3">
          {events.slice(0, 20).map((ev) => (
            <li key={ev.id} className="pl-5">
              <span className={`absolute left-[-4.5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white ${EVENT_DOT[ev.eventType] ?? "bg-zinc-300"}`} />
              <p className="text-sm text-zinc-900">
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
}

const PRIORITIES = ["P1", "P2", "P3", "P4"];
const TASK_TYPES = ["coding", "research", "writing", "review", "maintenance"];
const COST_LEVELS = ["low", "medium", "high"];

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<"tasks" | "debt" | "suggestions">("tasks");
  const [pendingSuggestionCount, setPendingSuggestionCount] = useState<number | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<{ id: string; title: string } | null>(null);
  const [deletingTask, setDeletingTask] = useState(false);
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "medium",
  });

  function loadProject() {
    fetch(`/api/projects/${id}`)
      .then((r) => {
        if (!r.ok) { router.push("/projects"); return null; }
        return r.json();
      })
      .then((data) => { if (data) setProject(data); });
  }

  useEffect(() => {
    loadProject();
    fetch(`/api/projects/${id}/suggestions`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: { status: string }[]) => {
        setPendingSuggestionCount(data.filter((s) => s.status === "pending_review").length);
      });
  }, [id]);

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

  if (!project) return <LoadingState />;

  return (
    <div className="p-8 max-w-5xl">
      <BackLink href="/projects" label="Projects" />

      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{project.name}</h1>
          {project.description && (
            <p className="text-sm text-zinc-700 mt-1">{project.description}</p>
          )}
        </div>
        <div className="flex gap-2 shrink-0 ml-4">
          <PriorityBadge priority={project.priority} />
          <StatusBadge status={project.status} />
        </div>
      </div>

      {/* ── Progress ───────────────────────────────────────────────────────── */}
      {project.totalTasks !== null && project.totalTasks > 0 && (
        <div className="bg-white rounded-xl border border-zinc-200 p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-zinc-900">
              Progress — {Math.round(project.completionPct ?? 0)}%
            </span>
            <div className="flex items-center gap-3 text-xs text-zinc-600">
              {project.runningTasks !== null && project.runningTasks > 0 && (
                <span className="text-blue-700">{project.runningTasks} running</span>
              )}
              {project.failedTasks !== null && project.failedTasks > 0 && (
                <span className="text-red-700">{project.failedTasks} failed</span>
              )}
              <span>{project.completedTasks ?? 0}/{project.totalTasks} done</span>
            </div>
          </div>
          <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
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

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 mb-4 border-b border-zinc-200">
        {(["tasks", "debt", "suggestions"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors rounded-t-md -mb-px border-b-2 flex items-center gap-1.5 ${
              activeTab === tab
                ? "border-zinc-900 text-zinc-900"
                : "border-transparent text-zinc-600 hover:text-zinc-900"
            }`}
          >
            {tab === "tasks"
              ? `Tasks (${project.tasks.length})`
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
            <h2 className="font-semibold text-zinc-900">
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
            <div className="bg-white rounded-xl border border-zinc-200 p-8 text-center">
              <p className="text-sm text-zinc-600 mb-4">No tasks yet.</p>
              <Btn variant="primary" onClick={openCreateTask}>Add first task</Btn>
            </div>
          ) : (
            <div className="space-y-2">
              {project.tasks.map((t) => (
                <div
                  key={t.id}
                  className="bg-white rounded-xl border border-zinc-200 p-4 flex items-center gap-4 hover:border-zinc-300 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/tasks/${t.id}`}
                      className="font-medium text-zinc-900 hover:text-blue-700 truncate block transition-colors"
                    >
                      {t.title}
                    </Link>
                    <div className="flex items-center gap-3 mt-1 text-xs text-zinc-600">
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
                      className="text-xs text-zinc-700 hover:text-zinc-900 font-medium transition-colors"
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
          <p className="text-sm text-zinc-700 mb-1">
            Delete task <strong>{confirmDeleteTask.title}</strong>?
          </p>
          <p className="text-sm text-zinc-600 mb-4">
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
    </div>
  );
}
