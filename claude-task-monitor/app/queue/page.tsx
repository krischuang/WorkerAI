"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
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
}

export default function QueuePage() {
  const [tasks, setTasks] = useState<QueueTask[]>([]);

  useEffect(() => {
    fetch("/api/queue")
      .then((r) => r.json())
      .then(setTasks);
  }, []);

  async function markRunning(id: string) {
    await fetch(`/api/tasks/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader
        title="Priority Queue"
        subtitle="Pending tasks sorted by project priority → task priority → age"
        action={
          tasks.length > 0 ? (
            <span className="text-sm text-zinc-600 font-medium">{tasks.length} pending</span>
          ) : undefined
        }
      />

      {tasks.length === 0 ? (
        <EmptyState message="No pending tasks. Great work!" />
      ) : (
        <div className="space-y-2">
          {tasks.map((t, i) => (
            <div
              key={t.id}
              className="bg-white rounded-xl border border-zinc-200 p-4 flex items-center gap-4"
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
                  className="font-medium text-zinc-900 hover:text-blue-700 truncate block transition-colors"
                >
                  {t.title}
                </Link>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-600">
                  <Link
                    href={`/projects/${t.project.id}`}
                    className="hover:text-zinc-900 transition-colors"
                  >
                    {t.project.name}
                  </Link>
                  <span>{t.taskType}</span>
                  <span>cost: {t.estimatedCostLevel}</span>
                </div>
              </div>
              <button
                onClick={() => markRunning(t.id)}
                className="shrink-0 text-xs bg-blue-700 text-white px-3 py-1.5 rounded-lg hover:bg-blue-800 font-medium transition-colors"
              >
                Start
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
