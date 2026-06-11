"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import { PageHeader, Modal, Btn, ModalActions, FormField, EmptyState, inputCls } from "@/app/_components/ui";

interface Project {
  id: string;
  name: string;
  description: string | null;
  priority: string;
  status: string;
  createdAt: string;
  _count: { tasks: number };
  tasks: Array<{ status: string }>;
  completionPct: number | null;
  totalTasks: number | null;
  completedTasks: number | null;
  estimatedCompletionAt: string | null;
}

const PRIORITIES = ["P1", "P2", "P3", "P4"];
const STATUSES = ["active", "paused", "archived"];

function countByStatus(tasks: Array<{ status: string }>, s: string) {
  return tasks.filter((t) => t.status === s).length;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    priority: "P3",
    status: "active",
  });

  function loadProjects() {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects);
  }

  useEffect(() => {
    loadProjects();
  }, []);

  function openCreate() {
    setEditProject(null);
    setForm({ name: "", description: "", priority: "P3", status: "active" });
    setShowForm(true);
  }

  function openEdit(p: Project) {
    setEditProject(p);
    setForm({
      name: p.name,
      description: p.description ?? "",
      priority: p.priority,
      status: p.status,
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editProject) {
      await fetch(`/api/projects/${editProject.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    } else {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    }
    setShowForm(false);
    loadProjects();
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    await fetch(`/api/projects/${confirmDelete.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmDelete(null);
    loadProjects();
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <PageHeader
        title="Projects"
        action={
          <Btn variant="primary" onClick={openCreate}>
            + New Project
          </Btn>
        }
      />

      {showForm && (
        <Modal
          title={editProject ? "Edit Project" : "New Project"}
          onClose={() => setShowForm(false)}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <FormField label="Name" required>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Tarot AI"
                className={inputCls}
              />
            </FormField>
            <FormField label="Description">
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                placeholder="What is this project about?"
                className={inputCls}
              />
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Priority">
                <select
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  className={inputCls}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Status">
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className={inputCls}
                >
                  {STATUSES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <ModalActions>
              <Btn type="submit" variant="primary" className="flex-1">
                {editProject ? "Save Changes" : "Create Project"}
              </Btn>
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => setShowForm(false)}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete Project" onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1">
            Delete project <strong>{confirmDelete.name}</strong>?
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            All tasks and execution logs will be permanently deleted.
            This cannot be undone.
          </p>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={doDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete Project"}
            </Btn>
          </ModalActions>
        </Modal>
      )}

      {projects.length === 0 ? (
        <EmptyState
          message="No projects yet."
          action={
            <Btn variant="primary" onClick={openCreate}>
              Create your first project
            </Btn>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((p) => (
            <div
              key={p.id}
              className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 flex flex-col gap-3 hover:border-zinc-300 dark:border-zinc-600 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/projects/${p.id}`}
                    className="font-semibold text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                  >
                    {p.name}
                  </Link>
                  {p.description && (
                    <p className="text-sm text-zinc-500 mt-0.5 line-clamp-2">
                      {p.description}
                    </p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <PriorityBadge priority={p.priority} />
                  <StatusBadge status={p.status} />
                </div>
              </div>

              <div className="flex gap-4 text-xs">
                <span className="text-zinc-500">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">{countByStatus(p.tasks, "pending")}</span> pending
                </span>
                <span className="text-zinc-500">
                  <span className="font-semibold text-blue-700">{countByStatus(p.tasks, "running")}</span> running
                </span>
                <span className="text-zinc-500">
                  <span className="font-semibold text-green-700">{countByStatus(p.tasks, "completed")}</span> done
                </span>
              </div>

              {p.totalTasks !== null && p.totalTasks > 0 && (
                <div>
                  <div className="flex justify-between text-xs text-zinc-500 mb-1.5">
                    <span>{Math.round(p.completionPct ?? 0)}% complete</span>
                    <span>{p.completedTasks ?? 0}/{p.totalTasks} tasks</span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full transition-all"
                      style={{ width: `${Math.min(p.completionPct ?? 0, 100)}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <button
                  onClick={() => openEdit(p)}
                  className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-100 font-medium transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
                  className="text-xs text-red-600 hover:text-red-800 font-medium transition-colors"
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
