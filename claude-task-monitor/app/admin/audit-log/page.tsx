"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader, Btn } from "@/app/_components/ui";

interface AdminAuditEntry {
  id: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

const ACTION_COLOR: Record<string, string> = {
  "config.updated":           "bg-blue-500",
  "archival.triggered":       "bg-amber-500",
  "suggestion.approved":      "bg-green-500",
  "suggestion.rejected":      "bg-red-400",
  "suggestions.bulk_approved":"bg-green-600",
  "suggestions.bulk_rejected":"bg-red-500",
  "server.created":           "bg-violet-500",
  "server.updated":           "bg-blue-400",
  "server.deleted":           "bg-red-600",
  "agent.created":            "bg-violet-400",
  "agent.updated":            "bg-blue-300",
  "agent.deleted":            "bg-red-600",
};

export default function AdminAuditLogPage() {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/audit-log")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AdminAuditEntry[] | null) => {
        if (data) setEntries(data);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <PageHeader
        title="Admin Actions"
        subtitle="Audit trail for all administrative mutations"
        action={
          <Btn variant="secondary" size="sm" onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Btn>
        }
      />

      {loading && entries.length === 0 && (
        <p className="text-sm text-zinc-500 mt-4">Loading…</p>
      )}

      {!loading && entries.length === 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-8 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No admin actions recorded yet.</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-700">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Action</th>
                <th className="hidden md:table-cell px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Target</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Actor</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Time</th>
                <th className="hidden md:table-cell px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {entries.map((entry) => {
                const isExpanded = expanded.has(entry.id);
                const hasPayload = Object.keys(entry.payload).length > 0;
                return (
                  <tr
                    key={entry.id}
                    className="hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:bg-zinc-950 cursor-default"
                    onClick={() => hasPayload && toggleExpand(entry.id)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block w-2 h-2 rounded-full shrink-0 ${ACTION_COLOR[entry.action] ?? "bg-zinc-400"}`}
                        />
                        <span className="font-mono text-xs text-zinc-800 dark:text-zinc-200">
                          {entry.action}
                        </span>
                      </div>
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-xs">
                      {entry.targetType && (
                        <span className="text-zinc-500 mr-1">{entry.targetType}</span>
                      )}
                      {entry.targetId && (
                        <span className="font-mono text-zinc-700 dark:text-zinc-300">
                          {entry.targetId.length > 12 ? `…${entry.targetId.slice(-8)}` : entry.targetId}
                        </span>
                      )}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400 font-mono">
                      {entry.actor}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-xs">
                      {hasPayload && (
                        <div>
                          {isExpanded ? (
                            <pre className="text-xs text-zinc-600 dark:text-zinc-300 font-mono bg-zinc-50 dark:bg-zinc-800 rounded p-2 max-w-xs overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(entry.payload, null, 2)}
                            </pre>
                          ) : (
                            <span className="text-zinc-400 font-mono truncate block max-w-xs">
                              {JSON.stringify(entry.payload).slice(0, 60)}
                              {JSON.stringify(entry.payload).length > 60 ? "…" : ""}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-4 py-2 border-t border-zinc-100 dark:border-zinc-800 text-xs text-zinc-500">
            Showing last {entries.length} admin action{entries.length !== 1 ? "s" : ""} — click a row to expand payload
          </div>
        </div>
      )}
    </div>
  );
}
