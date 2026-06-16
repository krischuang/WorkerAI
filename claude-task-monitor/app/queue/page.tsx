"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PageHeader, EmptyState } from "@/app/_components/ui";

interface QueueTask {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  taskType: string;
  estimatedCostLevel: string;
  createdAt: string;
  project: {
    id: string;
    name: string;
    priority: string;
    status: string;
  };
  server: {
    id: string;
    name: string;
    host: string;
  } | null;
}

export default function QueuePage() {
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  function loadQueue() {
    fetch("/api/queue")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setTasks(data); });
  }

  useEffect(() => {
    loadQueue();
  }, []);

  async function markRunning(id: string) {
    await fetch(`/api/tasks/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  async function runOnServer(id: string) {
    setRunning((prev) => ({ ...prev, [id]: true }));
    setErrors((prev) => { const n = { ...prev }; delete n[id]; return n; });
    try {
      const res = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [id]: data.error ?? "Failed to run" }));
        return;
      }
      if (data.blocked) {
        setErrors((prev) => ({ ...prev, [id]: "Usage limit reached — open task to see countdown" }));
        return;
      }
      // Success: task is now running, remove from queue
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch {
      setErrors((prev) => ({ ...prev, [id]: "Request failed" }));
    } finally {
      setRunning((prev) => { const n = { ...prev }; delete n[id]; return n; });
    }
  }

  const queuedTasks = tasks.filter((t) => t.status === "queued");
  const pendingTasks = tasks.filter((t) => t.status === "pending");

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader
        title="Priority Queue"
        subtitle="Tasks ready to run sorted by project priority → task priority → age"
        action={
          tasks.length > 0 ? (
            <span className="text-sm text-zinc-600 dark:text-zinc-400 font-medium">{tasks.length} waiting</span>
          ) : undefined
        }
      />

      {tasks.length === 0 ? (
        <EmptyState message="No tasks in queue. Great work!" />
      ) : (
        <div className="space-y-6">
          {/* ── Queued (server assigned, ready to run) ── */}
          {queuedTasks.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide mb-2">
                Ready to run ({queuedTasks.length})
              </h2>
              <div className="space-y-2">
                {queuedTasks.map((t, i) => (
                  <div
                    key={t.id}
                    className="bg-white dark:bg-zinc-900 rounded-xl border border-violet-200 p-4 flex items-center gap-4"
                  >
                    <div className="text-zinc-500 font-mono text-sm w-6 text-center shrink-0 select-none">
                      {i + 1}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <PriorityBadge priority={t.project.priority} />
                      <PriorityBadge priority={t.priority} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/tasks/${t.id}`}
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                      >
                        {t.title}
                      </Link>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                        <Link
                          href={`/projects/${t.project.id}`}
                          className="hover:text-zinc-900 dark:text-zinc-100 transition-colors"
                        >
                          {t.project.name}
                        </Link>
                        <span>{t.taskType}</span>
                        {t.server && (
                          <span className="text-violet-700 font-medium">
                            {t.server.name}
                          </span>
                        )}
                      </div>
                      {errors[t.id] && (
                        <p className="text-xs text-red-600 mt-1">{errors[t.id]}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBadge status={t.status} />
                      <button
                        onClick={() => runOnServer(t.id)}
                        disabled={running[t.id]}
                        className="text-xs bg-violet-700 text-white px-3 py-1.5 rounded-lg hover:bg-violet-800 font-medium transition-colors disabled:opacity-50"
                      >
                        {running[t.id] ? "Sending…" : "Run on Server"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Pending (no server assigned yet) ── */}
          {pendingTasks.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide mb-2">
                Pending — needs server ({pendingTasks.length})
              </h2>
              <div className="space-y-2">
                {pendingTasks.map((t, i) => (
                  <div
                    key={t.id}
                    className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 flex items-center gap-4"
                  >
                    <div className="text-zinc-500 font-mono text-sm w-6 text-center shrink-0 select-none">
                      {i + 1}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <PriorityBadge priority={t.project.priority} />
                      <PriorityBadge priority={t.priority} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/tasks/${t.id}`}
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-700 truncate block transition-colors"
                      >
                        {t.title}
                      </Link>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                        <Link
                          href={`/projects/${t.project.id}`}
                          className="hover:text-zinc-900 dark:text-zinc-100 transition-colors"
                        >
                          {t.project.name}
                        </Link>
                        <span>{t.taskType}</span>
                        <span>cost: {t.estimatedCostLevel}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBadge status={t.status} />
                      <button
                        onClick={() => markRunning(t.id)}
                        className="shrink-0 text-xs bg-blue-700 text-white px-3 py-1.5 rounded-lg hover:bg-blue-800 font-medium transition-colors"
                      >
                        Start
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
