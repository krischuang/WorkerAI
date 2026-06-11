"use client";

import { useCallback, useEffect, useState } from "react";
import { Btn, inputCls } from "@/app/_components/ui";
import { StatusBadge } from "@/app/_components/StatusBadge";
import Link from "next/link";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DepTask {
  id: string;
  title: string;
  status: string;
}

interface DepsData {
  prerequisites: { dependsOnId: string; dependsOn: DepTask }[];
  dependents:    { taskId: string;      task: DepTask }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Client-side reachability check: can we reach `targetId` from `startId` via existingEdges? */
function wouldCycle(
  taskId: string,
  newDepId: string,
  prerequisites: { dependsOnId: string }[],
  allProjectEdges: { taskId: string; dependsOnId: string }[],
): boolean {
  // Would adding taskId → newDepId create a cycle?
  // That happens if we can reach taskId from newDepId following existing edges.
  const adjMap = new Map<string, string[]>();
  for (const e of allProjectEdges) {
    if (!adjMap.has(e.taskId)) adjMap.set(e.taskId, []);
    adjMap.get(e.taskId)!.push(e.dependsOnId);
  }
  // Also include the current task's existing prerequisites
  for (const p of prerequisites) {
    if (!adjMap.has(taskId)) adjMap.set(taskId, []);
    if (!adjMap.get(taskId)!.includes(p.dependsOnId)) {
      adjMap.get(taskId)!.push(p.dependsOnId);
    }
  }

  // DFS from newDepId following dependency edges: can we reach taskId?
  const visited = new Set<string>();
  const stack = [newDepId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of (adjMap.get(cur) ?? [])) stack.push(next);
  }
  return false;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  taskId: string;
  projectId: string;
}

export function DependencyManager({ taskId, projectId }: Props) {
  const [deps,          setDeps]          = useState<DepsData | null>(null);
  const [allTasks,      setAllTasks]      = useState<DepTask[]>([]);
  const [allEdges,      setAllEdges]      = useState<{ taskId: string; dependsOnId: string }[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [selectedId,    setSelectedId]    = useState("");
  const [adding,        setAdding]        = useState(false);
  const [removingId,    setRemovingId]    = useState<string | null>(null);
  const [addError,      setAddError]      = useState<string | null>(null);

  const loadDeps = useCallback(() => {
    return fetch(`/api/tasks/${taskId}/dependencies`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setDeps(d); });
  }, [taskId]);

  const loadGraph = useCallback(() => {
    return fetch(`/api/projects/${projectId}/graph`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setAllTasks(d.tasks as DepTask[]);
          setAllEdges(d.edges);
        }
      });
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadDeps(), loadGraph()]).finally(() => setLoading(false));
  }, [loadDeps, loadGraph]);

  async function handleAdd() {
    if (!selectedId || !deps) return;
    setAddError(null);

    // Client-side cycle guard (quick check before hitting the network)
    if (selectedId === taskId) {
      setAddError("A task cannot depend on itself.");
      return;
    }
    if (wouldCycle(taskId, selectedId, deps.prerequisites, allEdges)) {
      setAddError("Adding this dependency would create a cycle.");
      return;
    }

    setAdding(true);
    const res = await fetch(`/api/tasks/${taskId}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: selectedId }),
    });
    setAdding(false);

    if (res.ok) {
      setSelectedId("");
      await Promise.all([loadDeps(), loadGraph()]);
    } else {
      const body = await res.json().catch(() => ({}));
      setAddError(body.error ?? "Failed to add dependency");
    }
  }

  async function handleRemove(dependsOnId: string) {
    setRemovingId(dependsOnId);
    await fetch(`/api/tasks/${taskId}/dependencies/${dependsOnId}`, { method: "DELETE" });
    setRemovingId(null);
    await Promise.all([loadDeps(), loadGraph()]);
  }

  if (loading) return null;
  if (!deps)   return null;

  // Compute available tasks: exclude self, already-added prerequisites, and tasks that
  // already depend on this task (adding them would obviously cycle).
  const prereqIds   = new Set(deps.prerequisites.map((p) => p.dependsOnId));
  const dependentIds = new Set(deps.dependents.map((d) => d.taskId));
  const available   = allTasks.filter(
    (t) => t.id !== taskId && !prereqIds.has(t.id) && !dependentIds.has(t.id),
  );

  return (
    <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
      <h2 className="font-semibold text-zinc-900 mb-4">Dependencies</h2>

      {/* ── Prerequisites ─────────────────────────────────────────────────── */}
      <div className="mb-5">
        <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide mb-2">
          Prerequisites — this task waits for:
        </p>
        {deps.prerequisites.length === 0 ? (
          <p className="text-sm text-zinc-500 italic">None</p>
        ) : (
          <ul className="space-y-1.5">
            {deps.prerequisites.map(({ dependsOnId, dependsOn }) => (
              <li key={dependsOnId} className="flex items-center gap-2">
                <StatusBadge status={dependsOn.status} />
                <Link
                  href={`/tasks/${dependsOnId}`}
                  className="text-sm text-zinc-900 hover:text-blue-700 flex-1 truncate transition-colors"
                  title={dependsOn.title}
                >
                  {dependsOn.title}
                </Link>
                <button
                  onClick={() => handleRemove(dependsOnId)}
                  disabled={removingId === dependsOnId}
                  className="text-xs text-red-600 hover:text-red-800 font-medium shrink-0 transition-colors disabled:opacity-50"
                >
                  {removingId === dependsOnId ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Dependents (read-only) ─────────────────────────────────────────── */}
      {deps.dependents.length > 0 && (
        <div className="mb-5">
          <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide mb-2">
            Downstream — tasks blocked until this completes:
          </p>
          <ul className="space-y-1.5">
            {deps.dependents.map(({ taskId: depTaskId, task }) => (
              <li key={depTaskId} className="flex items-center gap-2">
                <StatusBadge status={task.status} />
                <Link
                  href={`/tasks/${depTaskId}`}
                  className="text-sm text-zinc-900 hover:text-blue-700 flex-1 truncate transition-colors"
                  title={task.title}
                >
                  {task.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Add prerequisite ──────────────────────────────────────────────── */}
      {available.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide mb-2">
            Add prerequisite:
          </p>
          <div className="flex gap-2 items-start">
            <select
              value={selectedId}
              onChange={(e) => { setSelectedId(e.target.value); setAddError(null); }}
              className={`${inputCls} flex-1`}
            >
              <option value="">— select a task —</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>
                  [{t.status}] {t.title}
                </option>
              ))}
            </select>
            <Btn
              variant="primary"
              onClick={handleAdd}
              disabled={!selectedId || adding}
            >
              {adding ? "Adding…" : "Add"}
            </Btn>
          </div>
          {addError && (
            <p className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
              {addError}
            </p>
          )}
        </div>
      )}

      {available.length === 0 && deps.prerequisites.length === 0 && deps.dependents.length === 0 && (
        <p className="text-sm text-zinc-500 italic">No other tasks in this project to link to.</p>
      )}
    </section>
  );
}
