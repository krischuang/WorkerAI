"use client";

import { useEffect, useState } from "react";
import {
  PageHeader,
  Btn,
  Modal,
  ModalActions,
  FormField,
  EmptyState,
  inputCls,
} from "@/app/_components/ui";

interface TaskTemplate {
  id: string;
  name: string;
  category: string;
  taskType: string;
  estimatedCostLevel: string;
  priority: string;
  titleTemplate: string;
  descriptionTemplate: string;
  variables: string[];
  isBuiltIn: boolean;
  usageCount: number;
  createdAt: string;
}

const CATEGORY_BADGE: Record<string, string> = {
  review:    "bg-blue-50 text-blue-700 border-blue-200",
  testing:   "bg-violet-50 text-violet-700 border-violet-200",
  bugfix:    "bg-red-50 text-red-700 border-red-200",
  docs:      "bg-amber-50 text-amber-700 border-amber-200",
  refactor:  "bg-emerald-50 text-emerald-700 border-emerald-200",
  custom:    "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700",
};

const TASK_TYPES = ["coding", "research", "writing", "review", "maintenance"];
const COST_LEVELS = ["low", "medium", "high"];
const PRIORITIES = ["P1", "P2", "P3", "P4"];

const EMPTY_FORM = {
  name: "",
  category: "custom",
  taskType: "coding",
  estimatedCostLevel: "medium",
  priority: "P3",
  titleTemplate: "",
  descriptionTemplate: "",
  variablesRaw: "",
};

function extractVariables(text: string): string[] {
  const matches = text.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

export default function TaskTemplatesPage() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTpl, setEditTpl] = useState<TaskTemplate | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<TaskTemplate | null>(null);

  function loadTemplates() {
    fetch("/api/task-templates")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setTemplates(data); setLoading(false); });
  }

  useEffect(() => { loadTemplates(); }, []);

  function openCreate() {
    setEditTpl(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(t: TaskTemplate) {
    setEditTpl(t);
    setForm({
      name: t.name,
      category: t.category,
      taskType: t.taskType,
      estimatedCostLevel: t.estimatedCostLevel,
      priority: t.priority,
      titleTemplate: t.titleTemplate,
      descriptionTemplate: t.descriptionTemplate,
      variablesRaw: t.variables.join(", "),
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const variables = form.variablesRaw
      ? form.variablesRaw.split(",").map((v) => v.trim()).filter(Boolean)
      : extractVariables(form.titleTemplate + "\n" + form.descriptionTemplate);

    const payload = { ...form, variables };
    if (editTpl) {
      await fetch(`/api/task-templates/${editTpl.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch("/api/task-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    setSaving(false);
    setShowForm(false);
    loadTemplates();
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    await fetch(`/api/task-templates/${confirmDelete.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmDelete(null);
    loadTemplates();
  }

  if (loading) return <div className="p-8 text-sm text-zinc-600 dark:text-zinc-400">Loading…</div>;

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader
        title="Task Templates"
        subtitle="Reusable templates with variable substitution for common task types"
        action={
          <Btn onClick={openCreate}>+ New Template</Btn>
        }
      />

      {templates.length === 0 ? (
        <EmptyState message="No templates yet." />
      ) : (
        <div className="space-y-3">
          {templates.map((t) => (
            <div
              key={t.id}
              className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 hover:border-zinc-300 dark:border-zinc-600 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{t.name}</span>
                    {t.isBuiltIn && (
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700">
                        built-in
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                        CATEGORY_BADGE[t.category] ?? CATEGORY_BADGE.custom
                      }`}
                    >
                      {t.category}
                    </span>
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-zinc-50 dark:bg-zinc-950 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700">
                      {t.taskType}
                    </span>
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-zinc-50 dark:bg-zinc-950 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700">
                      {t.priority}
                    </span>
                    {t.usageCount > 0 && (
                      <span className="text-xs text-zinc-600 dark:text-zinc-400">{t.usageCount} uses</span>
                    )}
                  </div>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1 font-mono truncate">{t.titleTemplate}</p>
                  {t.variables.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {t.variables.map((v) => (
                        <code key={v} className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-1.5 py-0.5 rounded">
                          {`{{${v}}}`}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Btn size="sm" variant="secondary" onClick={() => setPreview(t)}>Preview</Btn>
                  {!t.isBuiltIn && (
                    <Btn size="sm" variant="secondary" onClick={() => openEdit(t)}>Edit</Btn>
                  )}
                  {!t.isBuiltIn && (
                    <button
                      onClick={() => setConfirmDelete({ id: t.id, name: t.name })}
                      className="text-xs text-red-700 hover:text-red-900 font-medium transition-colors px-1"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit form */}
      {showForm && (
        <Modal
          title={editTpl ? `Edit Template: ${editTpl.name}` : "New Task Template"}
          onClose={() => setShowForm(false)}
          size="lg"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Name" hint="Descriptive template name">
                <input
                  className={inputCls}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </FormField>
              <FormField label="Category">
                <input
                  className={inputCls}
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  placeholder="e.g. testing, docs, custom"
                />
              </FormField>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <FormField label="Task Type">
                <select
                  className={inputCls}
                  value={form.taskType}
                  onChange={(e) => setForm((f) => ({ ...f, taskType: e.target.value }))}
                >
                  {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </FormField>
              <FormField label="Cost Level">
                <select
                  className={inputCls}
                  value={form.estimatedCostLevel}
                  onChange={(e) => setForm((f) => ({ ...f, estimatedCostLevel: e.target.value }))}
                >
                  {COST_LEVELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FormField>
              <FormField label="Priority">
                <select
                  className={inputCls}
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                >
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </FormField>
            </div>
            <FormField label="Title Template" hint="Use {{variable}} placeholders">
              <input
                className={`${inputCls} font-mono`}
                value={form.titleTemplate}
                onChange={(e) => setForm((f) => ({ ...f, titleTemplate: e.target.value }))}
                placeholder="e.g. Fix: {{bug_description}}"
                required
              />
            </FormField>
            <FormField label="Description Template" hint="Markdown supported; use {{variable}} placeholders">
              <textarea
                className={`${inputCls} font-mono`}
                rows={8}
                value={form.descriptionTemplate}
                onChange={(e) => setForm((f) => ({ ...f, descriptionTemplate: e.target.value }))}
                placeholder="Describe the task…"
                required
              />
            </FormField>
            <FormField
              label="Variables (optional)"
              hint="Comma-separated names. Auto-detected from templates if left blank."
            >
              <input
                className={inputCls}
                value={form.variablesRaw}
                onChange={(e) => setForm((f) => ({ ...f, variablesRaw: e.target.value }))}
                placeholder="e.g. target, extra_context"
              />
            </FormField>
            <ModalActions>
              <Btn variant="secondary" type="button" onClick={() => setShowForm(false)}>Cancel</Btn>
              <Btn type="submit" disabled={saving}>{saving ? "Saving…" : editTpl ? "Save Changes" : "Create Template"}</Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {/* Preview modal */}
      {preview && (
        <Modal title={`Preview: ${preview.name}`} onClose={() => setPreview(null)} size="lg">
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 uppercase tracking-wide font-medium mb-1">Title Template</p>
              <p className="font-mono bg-zinc-50 dark:bg-zinc-950 rounded-lg p-3 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700">
                {preview.titleTemplate}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 uppercase tracking-wide font-medium mb-1">Description Template</p>
              <pre className="font-mono bg-zinc-50 dark:bg-zinc-950 rounded-lg p-3 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700 text-xs whitespace-pre-wrap overflow-auto max-h-64">
                {preview.descriptionTemplate}
              </pre>
            </div>
            {preview.variables.length > 0 && (
              <div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 uppercase tracking-wide font-medium mb-1">Variables</p>
                <div className="flex gap-1 flex-wrap">
                  {preview.variables.map((v) => (
                    <code key={v} className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700">
                      {`{{${v}}}`}
                    </code>
                  ))}
                </div>
              </div>
            )}
          </div>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setPreview(null)}>Close</Btn>
          </ModalActions>
        </Modal>
      )}

      {/* Confirm delete */}
      {confirmDelete && (
        <Modal title="Delete Template" onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">
            Delete template <strong>{confirmDelete.name}</strong>? This cannot be undone.
          </p>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={doDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}
