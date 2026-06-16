"use client";

import { useEffect, useState } from "react";
import { Modal, Btn, ModalActions, FormField, inputCls } from "@/app/_components/ui";

interface TaskTemplate {
  id: string;
  name: string;
  category: string;
  taskType: string;
  priority: string;
  titleTemplate: string;
  descriptionTemplate: string;
  variables: string[];
  isBuiltIn: boolean;
}

interface Props {
  projectId: string;
  onClose: () => void;
  onCreated: (task: { id: string; title: string }) => void;
}

export function CreateFromTemplateModal({ projectId, onClose, onCreated }: Props) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TaskTemplate | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/task-templates")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: TaskTemplate[] | null) => { if (data) setTemplates(data); setLoading(false); });
  }, []);

  function selectTemplate(t: TaskTemplate) {
    setSelected(t);
    const initVars: Record<string, string> = {};
    for (const v of t.variables) initVars[v] = "";
    setVars(initVars);
    setError(null);
  }

  function applyVars(template: string): string {
    return template.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, key: string) =>
      vars[key] ?? `{{${key}}}`
    );
  }

  async function handleUse(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch(`/api/task-templates/${selected.id}/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, variables: vars }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok) { setError(data.error ?? "Failed to create task"); return; }
    onCreated(data);
  }

  return (
    <Modal title="Create from Template" onClose={onClose} size="lg">
      {loading ? (
        <p className="text-sm text-zinc-600 py-4">Loading templates…</p>
      ) : !selected ? (
        <>
          <p className="text-sm text-zinc-700 mb-4">Choose a template to start from:</p>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTemplate(t)}
                className="w-full text-left rounded-lg border border-zinc-200 p-4 hover:border-zinc-400 hover:bg-zinc-50 transition-colors"
              >
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-zinc-900 text-sm">{t.name}</span>
                  {t.isBuiltIn && (
                    <span className="text-xs text-zinc-500 bg-zinc-100 rounded-full px-2 py-0.5 border border-zinc-200">
                      built-in
                    </span>
                  )}
                  <span className="text-xs text-zinc-600">{t.category}</span>
                  <span className="text-xs text-zinc-600">· {t.taskType}</span>
                  <span className="text-xs text-zinc-600">· {t.priority}</span>
                </div>
                <p className="text-xs text-zinc-600 font-mono truncate">{t.titleTemplate}</p>
                {t.variables.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {t.variables.map((v) => (
                      <code key={v} className="text-xs bg-zinc-100 text-zinc-700 px-1 rounded">
                        {`{{${v}}}`}
                      </code>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
          <ModalActions>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          </ModalActions>
        </>
      ) : (
        <form onSubmit={handleUse} className="space-y-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs text-zinc-600 hover:text-zinc-900 transition-colors"
            >
              ← Back
            </button>
            <span className="text-sm font-medium text-zinc-900">{selected.name}</span>
          </div>

          {selected.variables.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-600 uppercase tracking-wide font-medium">Fill in variables</p>
              {selected.variables.map((v) => (
                <FormField key={v} label={v.replace(/_/g, " ")}>
                  <input
                    className={inputCls}
                    value={vars[v] ?? ""}
                    onChange={(e) => setVars((prev) => ({ ...prev, [v]: e.target.value }))}
                    placeholder={`{{${v}}}`}
                  />
                </FormField>
              ))}
            </div>
          )}

          <div className="space-y-2 bg-zinc-50 rounded-lg p-3 border border-zinc-200">
            <p className="text-xs text-zinc-600 uppercase tracking-wide font-medium">Preview</p>
            <p className="text-sm font-medium text-zinc-900 font-mono">{applyVars(selected.titleTemplate)}</p>
            <pre className="text-xs text-zinc-700 whitespace-pre-wrap line-clamp-4 font-mono">
              {applyVars(selected.descriptionTemplate)}
            </pre>
          </div>

          {error && <p className="text-sm text-red-700">{error}</p>}

          <ModalActions>
            <Btn variant="secondary" type="button" onClick={onClose}>Cancel</Btn>
            <Btn type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create Task"}
            </Btn>
          </ModalActions>
        </form>
      )}
    </Modal>
  );
}
