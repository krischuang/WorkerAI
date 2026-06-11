"use client";

import { useEffect, useState, useCallback } from "react";
import { Btn, inputCls, Modal, ModalActions, FormField } from "@/app/_components/ui";

type SuggestionStatus = "pending_review" | "approved" | "rejected" | "converted";
type SourceType = "scan" | "debt" | "review" | "manual";

interface Suggestion {
  id: string;
  projectId: string;
  sourceType: SourceType;
  sourceId: string | null;
  title: string;
  description: string;
  priority: string;
  taskType: string;
  estimatedCostLevel: string;
  rationale: string | null;
  status: SuggestionStatus;
  convertedTaskId: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

const SOURCE_BADGE: Record<SourceType, string> = {
  scan: "bg-blue-50 text-blue-700 border-blue-200",
  debt: "bg-amber-50 text-amber-700 border-amber-200",
  review: "bg-violet-50 text-violet-700 border-violet-200",
  manual: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

const STATUS_BADGE: Record<SuggestionStatus, string> = {
  pending_review: "bg-yellow-50 text-yellow-700 border-yellow-200",
  approved: "bg-green-50 text-green-700 border-green-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  converted: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const STATUS_LABEL: Record<SuggestionStatus, string> = {
  pending_review: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  converted: "Converted",
};

const PRIORITIES = ["P1", "P2", "P3", "P4"];
const TASK_TYPES = ["coding", "research", "writing", "review", "maintenance"];
const COST_LEVELS = ["low", "medium", "high"];

interface EditForm {
  title: string;
  description: string;
  priority: string;
  taskType: string;
  estimatedCostLevel: string;
  rationale: string;
}

export function SuggestionsTab({ projectId }: { projectId: string }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkWorking, setBulkWorking] = useState(false);
  const [editTarget, setEditTarget] = useState<Suggestion | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Suggestion | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [working, setWorking] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    fetch(`/api/projects/${projectId}/suggestions`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Suggestion[]) => { setSuggestions(d); setLoading(false); });
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const pending = suggestions.filter((s) => s.status === "pending_review");
  const rest = suggestions.filter((s) => s.status !== "pending_review");

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllPending() {
    setSelectedIds(new Set(pending.map((s) => s.id)));
  }

  function clearSelection() { setSelectedIds(new Set()); }

  async function approve(id: string) {
    setWorking((w) => new Set(w).add(id));
    await fetch(`/api/suggestions/${id}/approve`, { method: "POST" });
    setWorking((w) => { const n = new Set(w); n.delete(id); return n; });
    load();
  }

  async function openReject(s: Suggestion) {
    setRejectTarget(s);
    setRejectNote("");
  }

  async function confirmReject() {
    if (!rejectTarget) return;
    setWorking((w) => new Set(w).add(rejectTarget.id));
    await fetch(`/api/suggestions/${rejectTarget.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewNote: rejectNote || undefined }),
    });
    setWorking((w) => { const n = new Set(w); n.delete(rejectTarget.id); return n; });
    setRejectTarget(null);
    load();
  }

  async function openEdit(s: Suggestion) {
    setEditTarget(s);
    setEditForm({
      title: s.title,
      description: s.description,
      priority: s.priority,
      taskType: s.taskType,
      estimatedCostLevel: s.estimatedCostLevel,
      rationale: s.rationale ?? "",
    });
  }

  async function saveEdit() {
    if (!editTarget || !editForm) return;
    setWorking((w) => new Set(w).add(editTarget.id));
    await fetch(`/api/suggestions/${editTarget.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editForm),
    });
    setWorking((w) => { const n = new Set(w); n.delete(editTarget.id); return n; });
    setEditTarget(null);
    load();
  }

  async function bulkApprove() {
    setBulkWorking(true);
    await Promise.all([...selectedIds].map((id) =>
      fetch(`/api/suggestions/${id}/approve`, { method: "POST" })
    ));
    setSelectedIds(new Set());
    setBulkWorking(false);
    load();
  }

  async function bulkReject() {
    setBulkWorking(true);
    await Promise.all([...selectedIds].map((id) =>
      fetch(`/api/suggestions/${id}/reject`, { method: "POST" })
    ));
    setSelectedIds(new Set());
    setBulkWorking(false);
    load();
  }

  async function generate() {
    setGenerating(true);
    const res = await fetch(`/api/projects/${projectId}/generate-suggestions`, { method: "POST" });
    setGenerating(false);
    if (res.ok) load();
  }

  if (loading) {
    return <p className="text-sm text-zinc-600 py-4">Loading suggestions…</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-700">
          {pending.length} pending · {suggestions.filter((s) => s.status === "converted").length} converted
        </p>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-zinc-600">{selectedIds.size} selected</span>
              <Btn variant="secondary" disabled={bulkWorking} onClick={bulkApprove}>
                Approve All
              </Btn>
              <Btn variant="danger" disabled={bulkWorking} onClick={bulkReject}>
                Reject All
              </Btn>
              <Btn variant="ghost" onClick={clearSelection}>Clear</Btn>
            </>
          )}
          <Btn variant="secondary" disabled={generating} onClick={generate}>
            {generating ? "Generating…" : "Generate Suggestions"}
          </Btn>
        </div>
      </div>

      {suggestions.length === 0 && (
        <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-8 text-center">
          <p className="text-sm text-zinc-700 font-medium mb-1">No suggestions yet</p>
          <p className="text-xs text-zinc-600">
            Click &ldquo;Generate Suggestions&rdquo; to create suggestions from scan findings and debt items.
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <section className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide">
              Pending Review ({pending.length})
            </h3>
            {pending.length > 1 && (
              <button onClick={selectAllPending} className="text-xs text-blue-700 hover:underline">
                Select all
              </button>
            )}
          </div>
          <div className="space-y-2">
            {pending.map((s) => (
              <SuggestionCard
                key={s.id}
                s={s}
                selected={selectedIds.has(s.id)}
                onToggle={() => toggleSelect(s.id)}
                onApprove={() => approve(s.id)}
                onReject={() => openReject(s)}
                onEdit={() => openEdit(s)}
                working={working.has(s.id)}
              />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide mb-2">
            History ({rest.length})
          </h3>
          <div className="space-y-2">
            {rest.map((s) => (
              <SuggestionCard
                key={s.id}
                s={s}
                selected={false}
                onToggle={() => {}}
                onApprove={() => {}}
                onReject={() => {}}
                onEdit={() => {}}
                working={false}
                readonly
              />
            ))}
          </div>
        </section>
      )}

      {/* Reject modal */}
      {rejectTarget && (
        <Modal title="Reject Suggestion" size="md" onClose={() => setRejectTarget(null)}>
          <p className="text-sm text-zinc-700 mb-4 font-medium">{rejectTarget.title}</p>
          <FormField label="Rejection note (optional)">
            <textarea
              className={`${inputCls} h-20 resize-none`}
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="Why are you rejecting this suggestion?"
            />
          </FormField>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setRejectTarget(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={confirmReject}>Reject</Btn>
          </ModalActions>
        </Modal>
      )}

      {/* Edit modal */}
      {editTarget && editForm && (
        <Modal title="Edit Suggestion" size="lg" onClose={() => setEditTarget(null)}>
          <div className="space-y-3">
            <FormField label="Title">
              <input
                className={inputCls}
                value={editForm.title}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              />
            </FormField>
            <FormField label="Description">
              <textarea
                className={`${inputCls} h-28 resize-none`}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </FormField>
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Priority">
                <select
                  className={inputCls}
                  value={editForm.priority}
                  onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}
                >
                  {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </FormField>
              <FormField label="Task Type">
                <select
                  className={inputCls}
                  value={editForm.taskType}
                  onChange={(e) => setEditForm({ ...editForm, taskType: e.target.value })}
                >
                  {TASK_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </FormField>
              <FormField label="Cost Level">
                <select
                  className={inputCls}
                  value={editForm.estimatedCostLevel}
                  onChange={(e) => setEditForm({ ...editForm, estimatedCostLevel: e.target.value })}
                >
                  {COST_LEVELS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </FormField>
            </div>
            <FormField label="Rationale">
              <input
                className={inputCls}
                value={editForm.rationale}
                onChange={(e) => setEditForm({ ...editForm, rationale: e.target.value })}
              />
            </FormField>
          </div>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={saveEdit}>Save</Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

function SuggestionCard({
  s, selected, onToggle, onApprove, onReject, onEdit, working, readonly,
}: {
  s: Suggestion;
  selected: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  working: boolean;
  readonly?: boolean;
}) {
  return (
    <div
      className={`bg-white border rounded-xl p-4 transition-colors ${
        selected ? "border-zinc-900 bg-zinc-50" : "border-zinc-200"
      }`}
    >
      <div className="flex items-start gap-3">
        {!readonly && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="mt-1 accent-zinc-900"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase ${
                SOURCE_BADGE[s.sourceType]
              }`}
            >
              {s.sourceType}
            </span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                STATUS_BADGE[s.status]
              }`}
            >
              {STATUS_LABEL[s.status]}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700 border border-zinc-200 font-semibold">
              {s.priority}
            </span>
            <span className="text-[10px] text-zinc-500">{s.taskType}</span>
          </div>
          <p className="text-sm font-medium text-zinc-900">{s.title}</p>
          <p className="text-xs text-zinc-600 mt-0.5 line-clamp-2">{s.description}</p>
          {s.rationale && (
            <p className="text-xs text-zinc-500 mt-1 italic">{s.rationale}</p>
          )}
          {s.reviewNote && (
            <p className="text-xs text-zinc-500 mt-1">Note: {s.reviewNote}</p>
          )}
          {s.convertedTaskId && (
            <p className="text-xs text-emerald-700 mt-1 font-medium">→ Task created</p>
          )}
        </div>
        {!readonly && s.status === "pending_review" && (
          <div className="flex items-center gap-1 shrink-0">
            <Btn variant="ghost" size="sm" onClick={onEdit} disabled={working}>Edit</Btn>
            <Btn variant="danger" size="sm" onClick={onReject} disabled={working}>Reject</Btn>
            <Btn variant="primary" size="sm" onClick={onApprove} disabled={working}>
              {working ? "…" : "Approve"}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
