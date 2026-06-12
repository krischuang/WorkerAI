"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { CalendarClock, PlusCircle, Pencil, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
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
import { PriorityBadge } from "@/app/_components/PriorityBadge";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  priority: string;
}

interface ScheduledTask {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  cronSchedule: string;
  priority: string;
  taskType: string;
  estimatedCostLevel: string;
  timeoutMinutes: number | null;
  maxRetries: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  project: { name: string; priority: string };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIORITIES = ["P1", "P2", "P3", "P4"];
const TASK_TYPES = ["coding", "research", "writing", "review", "maintenance"];
const COST_LEVELS = ["low", "medium", "high"];

const CRON_PRESETS = [
  { label: "Every hour",           value: "0 * * * *" },
  { label: "Every day at midnight",value: "0 0 * * *" },
  { label: "Every day at 3 AM",    value: "0 3 * * *" },
  { label: "Every weekday at 9 AM",value: "0 9 * * 1-5" },
  { label: "Every Sunday at 1 AM", value: "0 1 * * 0" },
  { label: "Every Monday at 8 AM", value: "0 8 * * 1" },
  { label: "First of month at 6 AM",value:"0 6 1 * *" },
];

const defaultForm = {
  projectId: "",
  title: "",
  description: "",
  cronSchedule: "0 3 * * *",
  priority: "P3",
  taskType: "coding",
  estimatedCostLevel: "medium",
  timeoutMinutes: "",
  maxRetries: "0",
  enabled: true,
};

type FormState = typeof defaultForm;

// ── Cron description (client-side, mirrors lib/cron-schedule.ts logic) ────────

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeCronSimple(expr: string): string {
  const common: Record<string, string> = {
    "* * * * *":    "Every minute",
    "0 * * * *":    "Every hour at :00",
    "0 0 * * *":    "Every day at 00:00",
    "0 3 * * *":    "Every day at 03:00",
    "0 9 * * 1-5":  "Weekdays at 09:00",
    "0 1 * * 0":    "Every Sunday at 01:00",
    "0 8 * * 1":    "Every Monday at 08:00",
    "0 6 1 * *":    "First of month at 06:00",
  };
  if (common[expr.trim()]) return common[expr.trim()];

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Custom schedule";
  const [min, hr, , , dow] = parts;
  if (min !== "*" && hr !== "*" && /^\d+$/.test(min) && /^\d+$/.test(hr)) {
    const timeStr = `${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "*") return `Every day at ${timeStr}`;
    if (dow === "1-5") return `Weekdays at ${timeStr}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${timeStr}`;
    if (/^\d$/.test(dow)) return `Every ${DOW_NAMES[parseInt(dow)] ?? "??"} at ${timeStr}`;
  }
  return "Custom schedule";
}

// ── Relative time helper ──────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60_000) return past ? "just now" : "in <1 min";
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(abs / 86_400_000);
  return past ? `${d}d ago` : `in ${d}d`;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ScheduledTasksPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-zinc-500">Loading…</div>}>
      <ScheduledTasksPageInner />
    </Suspense>
  );
}

function ScheduledTasksPageInner() {
  const [tasks, setTasks]       = useState<ScheduledTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledTask | null>(null);
  const [form, setForm]         = useState<FormState>(defaultForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [tasksRes, projectsRes] = await Promise.all([
      fetch("/api/scheduled-tasks"),
      fetch("/api/projects"),
    ]);
    if (tasksRes.ok) setTasks(await tasksRes.json());
    if (projectsRes.ok) {
      const data = await projectsRes.json();
      setProjects(Array.isArray(data) ? data : data.projects ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    const first = projects[0];
    setForm({ ...defaultForm, projectId: first?.id ?? "", priority: first?.priority ?? "P3" });
    setEditTarget(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(task: ScheduledTask) {
    setForm({
      projectId: task.projectId,
      title: task.title,
      description: task.description ?? "",
      cronSchedule: task.cronSchedule,
      priority: task.priority,
      taskType: task.taskType,
      estimatedCostLevel: task.estimatedCostLevel,
      timeoutMinutes: task.timeoutMinutes != null ? String(task.timeoutMinutes) : "",
      maxRetries: String(task.maxRetries),
      enabled: task.enabled,
    });
    setEditTarget(task);
    setError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const payload = {
      ...form,
      timeoutMinutes: form.timeoutMinutes ? Number(form.timeoutMinutes) : null,
      maxRetries: Number(form.maxRetries),
    };

    const url = editTarget ? `/api/scheduled-tasks/${editTarget.id}` : "/api/scheduled-tasks";
    const method = editTarget ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError((data as { error?: string }).error ?? "Save failed");
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    setShowForm(false);
    load();
  }

  async function handleToggle(task: ScheduledTask) {
    await fetch(`/api/scheduled-tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !task.enabled }),
    });
    load();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/scheduled-tasks/${id}`, { method: "DELETE" });
    setDeleteConfirm(null);
    load();
  }

  if (loading) return <LoadingState message="Loading scheduled tasks…" />;

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader
        title="Scheduled Tasks"
        action={
          <Btn variant="primary" onClick={openCreate} disabled={projects.length === 0}>
            <PlusCircle className="w-4 h-4 mr-1.5" />
            New Schedule
          </Btn>
        }
      />

      {projects.length === 0 && (
        <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          Create a project first before adding scheduled tasks.
        </div>
      )}

      {tasks.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          message="No scheduled tasks — set up recurring tasks to run automatically on a cron schedule."
          action={
            projects.length > 0 ? (
              <Btn variant="primary" onClick={openCreate}>
                <PlusCircle className="w-4 h-4 mr-1.5" />
                New Schedule
              </Btn>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`bg-white dark:bg-zinc-900 rounded-xl border p-4 flex items-start gap-4 ${
                task.enabled
                  ? "border-zinc-200 dark:border-zinc-700"
                  : "border-zinc-100 dark:border-zinc-800 opacity-60"
              }`}
            >
              <CalendarClock className={`w-5 h-5 mt-0.5 shrink-0 ${task.enabled ? "text-blue-600" : "text-zinc-400"}`} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100 text-sm">{task.title}</span>
                  <PriorityBadge priority={task.priority} />
                  {!task.enabled && (
                    <span className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-500 px-2 py-0.5 rounded-full">
                      Paused
                    </span>
                  )}
                </div>

                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
                  {task.project.name} · {task.taskType}
                </p>

                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-xs font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-2 py-0.5 rounded">
                    {task.cronSchedule}
                  </span>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    {describeCronSimple(task.cronSchedule)}
                  </span>
                </div>

                <div className="flex gap-4 mt-1.5 text-xs text-zinc-500">
                  {task.nextRunAt && (
                    <span>
                      Next: <span className="text-zinc-700 dark:text-zinc-300 font-medium">{relativeTime(task.nextRunAt)}</span>
                      {" "}({new Date(task.nextRunAt).toLocaleString()})
                    </span>
                  )}
                  {task.lastRunAt && (
                    <span>Last: {relativeTime(task.lastRunAt)}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => handleToggle(task)}
                  title={task.enabled ? "Pause schedule" : "Enable schedule"}
                  className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700 transition-colors"
                >
                  {task.enabled
                    ? <ToggleRight className="w-5 h-5 text-blue-600" />
                    : <ToggleLeft className="w-5 h-5" />
                  }
                </button>
                <button
                  onClick={() => openEdit(task)}
                  title="Edit"
                  className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700 transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setDeleteConfirm(task.id)}
                  title="Delete"
                  className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950 text-zinc-500 hover:text-red-600 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Create / Edit modal ────────────────────────────────────────────── */}
      {showForm && (
        <Modal
          title={editTarget ? "Edit Scheduled Task" : "New Scheduled Task"}
          onClose={() => setShowForm(false)}
          size="lg"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            {!editTarget && (
              <FormField label="Project" required>
                <select
                  required
                  value={form.projectId}
                  onChange={(e) => {
                    const proj = projects.find((p) => p.id === e.target.value);
                    setForm({ ...form, projectId: e.target.value, priority: proj?.priority ?? form.priority });
                  }}
                  className={inputCls}
                >
                  <option value="">Select a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>[{p.priority}] {p.name}</option>
                  ))}
                </select>
              </FormField>
            )}

            <FormField label="Task Title" required>
              <input
                required
                autoFocus
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Nightly data pull"
                className={inputCls}
              />
            </FormField>

            <FormField label="Description">
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                placeholder="What this task does…"
                className={inputCls}
              />
            </FormField>

            {/* Cron schedule */}
            <FormField
              label="Cron Schedule"
              hint={describeCronSimple(form.cronSchedule)}
              required
            >
              <div className="space-y-2">
                <input
                  required
                  value={form.cronSchedule}
                  onChange={(e) => setForm({ ...form, cronSchedule: e.target.value })}
                  placeholder="0 3 * * *"
                  className={`${inputCls} font-mono`}
                />
                <div className="flex flex-wrap gap-1.5">
                  {CRON_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setForm({ ...form, cronSchedule: p.value })}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        form.cronSchedule === p.value
                          ? "bg-blue-600 border-blue-600 text-white"
                          : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
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

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Timeout (minutes)" hint="Leave blank to use server default">
                <input
                  type="number"
                  min={1}
                  value={form.timeoutMinutes}
                  onChange={(e) => setForm({ ...form, timeoutMinutes: e.target.value })}
                  placeholder="e.g. 60"
                  className={inputCls}
                />
              </FormField>
              <FormField label="Max Retries">
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={form.maxRetries}
                  onChange={(e) => setForm({ ...form, maxRetries: e.target.value })}
                  className={inputCls}
                />
              </FormField>
            </div>

            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="rounded"
              />
              Enable immediately
            </label>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded px-3 py-2">
                {error}
              </p>
            )}

            <ModalActions>
              <Btn type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
              <Btn type="submit" variant="primary" disabled={submitting}>
                {submitting ? "Saving…" : editTarget ? "Save Changes" : "Create Schedule"}
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {/* ── Delete confirmation ────────────────────────────────────────────── */}
      {deleteConfirm && (
        <Modal title="Delete Schedule?" onClose={() => setDeleteConfirm(null)}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">
            This will remove the schedule. Already-created tasks will not be affected.
          </p>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setDeleteConfirm(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={() => handleDelete(deleteConfirm)}>Delete</Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}
