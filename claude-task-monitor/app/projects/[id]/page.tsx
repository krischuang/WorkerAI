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
}

const PRIORITIES = ["P1", "P2", "P3", "P4"];
const TASK_TYPES = ["coding", "research", "writing", "review", "maintenance"];
const COST_LEVELS = ["low", "medium", "high"];

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
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
  }, [id]);

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

  async function handleDeleteTask(taskId: string, title: string) {
    if (!confirm(`Delete task "${title}"?`)) return;
    await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
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

      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-zinc-900">
          Tasks ({project.tasks.length})
        </h2>
        <Btn variant="primary" onClick={openCreateTask}>
          + Add Task
        </Btn>
      </div>

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
                  onClick={() => handleDeleteTask(t.id, t.title)}
                  className="text-xs text-red-700 hover:text-red-900 font-medium transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
