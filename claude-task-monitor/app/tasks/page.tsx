"use client";

import { useEffect, useState } from "react";
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
  project: { name: string; priority: string };
  _count: { executionLogs: number };
  executionLogs: { startedAt: string; finishedAt: string | null }[];
}

function timeAgo(dateStr: string): string {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

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

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templateProjectId, setTemplateProjectId] = useState<string>("");
  const [form, setForm] = useState(defaultForm);
  const [submitting, setSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);

  function loadTasks() {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then((data) => {
        setTasks(data);
        setLoading(false);
      });
  }

  function loadProjects() {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: Project[]) => {
        setProjects(data);
        if (data.length > 0) {
          setForm((f) => ({ ...f, projectId: f.projectId || data[0].id }));
        }
      });
  }

  useEffect(() => {
    loadTasks();
    loadProjects();
  }, []);

  function handleFilterChange(status: string) {
    setStatusFilter(status);
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
    const completedCount = tasks.filter((t) => t.status === "completed").length;
    if (completedCount === 0) return;
    if (!confirm(`Delete all ${completedCount} completed task${completedCount !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    setClearing(true);
    await fetch("/api/tasks?status=completed", { method: "DELETE" });
    setClearing(false);
    loadTasks();
  }

  const sortedTasks = [...tasks].sort((a, b) => {
    const aRun = a.executionLogs[0]?.startedAt;
    const bRun = b.executionLogs[0]?.startedAt;
    if (!aRun && !bRun) return 0;
    if (!aRun) return 1;
    if (!bRun) return -1;
    return new Date(bRun).getTime() - new Date(aRun).getTime();
  });

  const filteredTasks = sortedTasks.filter((t) => {
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (projectFilter !== "all" && t.projectId !== projectFilter) return false;
    return true;
  });

  if (loading) return <LoadingState />;

  return (
    <div className="p-8 max-w-5xl">
      <PageHeader
        title="Tasks"
        subtitle="All tasks across every project"
        action={
          <div className="flex gap-2">
            {tasks.some((t) => t.status === "completed") && (
              <Btn variant="secondary" onClick={clearCompleted} disabled={clearing}>
                {clearing ? "Clearing…" : "Clear completed"}
              </Btn>
            )}
            <Btn
              variant="secondary"
              onClick={() => {
                setTemplateProjectId(projects.length === 1 ? projects[0].id : "");
                setShowTemplateModal(true);
              }}
              disabled={projects.length === 0}
            >
              From Template
            </Btn>
            <Btn variant="primary" onClick={openForm} disabled={projects.length === 0}>
              + New Task
            </Btn>
          </div>
        }
      />

      {/* Filters */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => handleFilterChange(s)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors capitalize ${
                statusFilter === s
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {projects.length > 0 && (
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="text-sm border border-zinc-300 rounded-lg px-3 py-1.5 text-zinc-700 bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {filteredTasks.length === 0 ? (
        <EmptyState
          message={
            statusFilter !== "all" || projectFilter !== "all"
              ? "No tasks match the selected filters."
              : "Create your first task to get started."
          }
        />
      ) : (
        <div className="space-y-2">
          {filteredTasks.map((task) => (
            <button
              key={task.id}
              onClick={() => setSelectedTaskId(task.id)}
              className="w-full text-left bg-white border border-zinc-200 rounded-lg px-5 py-4 hover:border-zinc-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-zinc-900 truncate">{task.title}</p>
                  <p className="text-sm text-zinc-600 mt-0.5">
                    {task.project.name}
                    <span className="text-zinc-400 mx-1.5">·</span>
                    <span className="capitalize">{task.taskType}</span>
                    {task._count.executionLogs > 0 && (
                      <>
                        <span className="text-zinc-400 mx-1.5">·</span>
                        {task._count.executionLogs} log{task._count.executionLogs !== 1 ? "s" : ""}
                      </>
                    )}
                    {task.executionLogs[0] && (
                      <>
                        <span className="text-zinc-400 mx-1.5">·</span>
                        Last run {timeAgo(task.executionLogs[0].startedAt)}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <PriorityBadge priority={task.priority} />
                  <StatusBadge status={task.status} />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

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
                  <option key={p.id} value={p.id}>
                    [{p.priority}] {p.name}
                  </option>
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
                <select
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  className={inputCls}
                >
                  {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </FormField>
              <FormField label="Type">
                <select
                  value={form.taskType}
                  onChange={(e) => setForm({ ...form, taskType: e.target.value })}
                  className={inputCls}
                >
                  {TASK_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </FormField>
              <FormField label="Cost">
                <select
                  value={form.estimatedCostLevel}
                  onChange={(e) => setForm({ ...form, estimatedCostLevel: e.target.value })}
                  className={inputCls}
                >
                  {COST_LEVELS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </FormField>
            </div>

            <ModalActions>
              <Btn type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Cancel
              </Btn>
              <Btn type="submit" variant="primary" disabled={submitting}>
                {submitting ? "Creating…" : "Create Task"}
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {showTemplateModal && !templateProjectId && (
        <Modal title="Choose Project" onClose={() => setShowTemplateModal(false)}>
          <p className="text-sm text-zinc-700 mb-4">Select the project this task belongs to:</p>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => setTemplateProjectId(p.id)}
                className="w-full text-left rounded-lg border border-zinc-200 px-4 py-3 hover:border-zinc-400 hover:bg-zinc-50 transition-colors text-sm font-medium text-zinc-900"
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
    </div>
  );
}
