"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader, Btn, inputCls } from "@/app/_components/ui";

interface AuditEvent {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actorType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const EVENT_DOT: Record<string, string> = {
  "task.created":           "bg-zinc-400",
  "task.queued":            "bg-violet-500",
  "task.dispatched":        "bg-blue-500",
  "task.completed":         "bg-green-500",
  "task.failed":            "bg-red-500",
  "task.timeout":           "bg-red-400",
  "task.retried":           "bg-amber-400",
  "task.review.sent":       "bg-sky-400",
  "task.review.done":       "bg-emerald-500",
  "task.review.incomplete": "bg-amber-500",
  "agent.offline":          "bg-zinc-500",
};

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [filterEntityType, setFilterEntityType] = useState("");
  const [filterEntityId, setFilterEntityId] = useState("");
  const [filterEventType, setFilterEventType] = useState("");
  const [filterSince, setFilterSince] = useState("");

  const buildUrl = useCallback((cursor?: string) => {
    const params = new URLSearchParams();
    if (filterEntityType) params.set("entityType", filterEntityType);
    if (filterEntityId) params.set("entityId", filterEntityId.trim());
    if (filterEventType) params.set("eventType", filterEventType);
    if (filterSince) params.set("since", new Date(filterSince).toISOString());
    if (cursor) params.set("cursor", cursor);
    return `/api/audit?${params.toString()}`;
  }, [filterEntityType, filterEntityId, filterEventType, filterSince]);

  function search() {
    setLoading(true);
    fetch(buildUrl())
      .then((r) => r.json())
      .then((data: { events: AuditEvent[]; nextCursor: string | null }) => {
        setEvents(data.events);
        setNextCursor(data.nextCursor);
      })
      .finally(() => setLoading(false));
  }

  function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    fetch(buildUrl(nextCursor))
      .then((r) => r.json())
      .then((data: { events: AuditEvent[]; nextCursor: string | null }) => {
        setEvents((prev) => [...prev, ...data.events]);
        setNextCursor(data.nextCursor);
      })
      .finally(() => setLoadingMore(false));
  }

  useEffect(() => {
    search();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader
        title="Audit Log"
        subtitle="Immutable event history across all tasks, agents, and servers"
      />

      {/* Filters */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4 mb-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mb-3">
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Entity Type</label>
            <select
              value={filterEntityType}
              onChange={(e) => setFilterEntityType(e.target.value)}
              className={inputCls}
            >
              <option value="">All</option>
              <option value="task">task</option>
              <option value="agent">agent</option>
              <option value="server">server</option>
              <option value="project">project</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Entity ID</label>
            <input
              value={filterEntityId}
              onChange={(e) => setFilterEntityId(e.target.value)}
              placeholder="cuid…"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Event Type</label>
            <select
              value={filterEventType}
              onChange={(e) => setFilterEventType(e.target.value)}
              className={inputCls}
            >
              <option value="">All</option>
              <option value="task.created">task.created</option>
              <option value="task.queued">task.queued</option>
              <option value="task.dispatched">task.dispatched</option>
              <option value="task.completed">task.completed</option>
              <option value="task.failed">task.failed</option>
              <option value="task.timeout">task.timeout</option>
              <option value="task.review.sent">task.review.sent</option>
              <option value="task.review.done">task.review.done</option>
              <option value="task.review.incomplete">task.review.incomplete</option>
              <option value="agent.offline">agent.offline</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Since</label>
            <input
              type="datetime-local"
              value={filterSince}
              onChange={(e) => setFilterSince(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>
        <Btn variant="primary" size="sm" onClick={search} disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </Btn>
      </div>

      {/* Results */}
      {events.length === 0 && !loading && (
        <div className="bg-white rounded-xl border border-zinc-200 p-8 text-center">
          <p className="text-sm text-zinc-600">No events found matching the current filters.</p>
        </div>
      )}

      {events.length > 0 && (
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Event</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Entity</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Actor</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Time</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-600">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {events.map((ev) => (
                <tr key={ev.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${EVENT_DOT[ev.eventType] ?? "bg-zinc-300"}`} />
                      <span className="font-mono text-xs text-zinc-800">{ev.eventType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-zinc-500 mr-1">{ev.entityType}</span>
                    <span className="font-mono text-xs text-zinc-700">{ev.entityId.slice(-8)}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600">{ev.actorType}</td>
                  <td className="px-4 py-3 text-xs text-zinc-600 whitespace-nowrap">
                    {new Date(ev.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    {Object.keys(ev.payload).length > 0 && (
                      <pre className="text-xs text-zinc-500 font-mono max-w-xs overflow-hidden text-ellipsis">
                        {JSON.stringify(ev.payload).slice(0, 80)}
                      </pre>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="px-4 py-3 border-t border-zinc-100 text-center">
              <Btn variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
