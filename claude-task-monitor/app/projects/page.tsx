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

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete project "${name}" and all its tasks?`)) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    loadProjects();
  }

  return (
    <div className="p-8 max-w-5xl">
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
              className="bg-white rounded-xl border border-zinc-200 p-5 flex flex-col gap-3 hover:border-zinc-300 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/projects/${p.id}`}
                    className="font-semibold text-zinc-900 hover:text-blue-700 truncate block transition-colors"
                  >
                    {p.name}
                  </Link>
                  {p.description && (
                    <p className="text-sm text-zinc-700 mt-0.5 line-clamp-2">
                      {p.description}
                    </p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <PriorityBadge priority={p.priority} />
                  <StatusBadge status={p.status} />
                </div>
              </div>

              <div className="flex gap-3 text-xs font-medium">
                <span className="text-zinc-700">{countByStatus(p.tasks, "pending")} pending</span>
                <span className="text-blue-700">{countByStatus(p.tasks, "running")} running</span>
                <span className="text-green-700">{countByStatus(p.tasks, "completed")} done</span>
              </div>

              <div className="flex gap-3 pt-1 border-t border-zinc-100">
                <button
                  onClick={() => openEdit(p)}
                  className="text-xs text-zinc-700 hover:text-zinc-900 font-medium transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(p.id, p.name)}
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
