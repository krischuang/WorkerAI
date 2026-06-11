"use client";

import { useEffect, useState } from "react";
import { Btn, Modal, ModalActions, FormField, inputCls } from "@/app/_components/ui";

interface DebtItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  category: "architecture" | "testing" | "documentation" | "security" | "performance";
  status: "open" | "acknowledged" | "in_progress" | "resolved" | "wont_fix";
  evidence: { source?: string; excerpt?: string };
  resolvedAt: string | null;
  createdAt: string;
}

interface Server {
  id: string;
  name: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high:     "bg-orange-100 text-orange-800 border-orange-200",
  medium:   "bg-amber-100 text-amber-800 border-amber-200",
  low:      "bg-zinc-100 text-zinc-700 border-zinc-200",
};

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high:     "bg-orange-500",
  medium:   "bg-amber-400",
  low:      "bg-zinc-400",
};

const CATEGORY_LABEL: Record<string, string> = {
  architecture:  "Architecture",
  testing:       "Testing",
  documentation: "Docs",
  security:      "Security",
  performance:   "Performance",
};

const STATUS_LABEL: Record<string, string> = {
  open:         "Open",
  acknowledged: "Acknowledged",
  in_progress:  "In Progress",
  resolved:     "Resolved",
  wont_fix:     "Won't Fix",
};

const STATUSES = ["open", "acknowledged", "in_progress", "resolved", "wont_fix"];

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${SEVERITY_COLOR[severity] ?? "bg-zinc-100 text-zinc-700 border-zinc-200"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[severity] ?? "bg-zinc-400"}`} />
      {severity}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-700 border border-zinc-200">
      {CATEGORY_LABEL[category] ?? category}
    </span>
  );
}

// Simple sparkline showing open debt count over the last 8 weeks
function DebtTrendChart({ items }: { items: DebtItem[] }) {
  const now = Date.now();
  const WEEKS = 8;
  // For each week bucket: count items created at or before that week end that are still open or were open at that time
  const weekData: { label: string; open: number }[] = [];
  for (let w = WEEKS - 1; w >= 0; w--) {
    const weekEnd = now - w * 7 * 86_400_000;
    const weekStart = weekEnd - 7 * 86_400_000;
    const label = new Date(weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const open = items.filter((item) => {
      const created = new Date(item.createdAt).getTime();
      const resolved = item.resolvedAt ? new Date(item.resolvedAt).getTime() : null;
      // Open during this week: created before week end AND (not resolved OR resolved after week start)
      return created <= weekEnd && (resolved === null || resolved >= weekStart);
    }).length;
    weekData.push({ label, open });
  }

  const maxVal = Math.max(1, ...weekData.map((d) => d.open));
  const W = 480;
  const H = 80;
  const padL = 28;
  const padB = 20;
  const padT = 8;
  const chartW = W - padL - 4;
  const chartH = H - padB - padT;
  const xStep = chartW / (WEEKS - 1);

  const pts = weekData.map((d, i) => {
    const x = padL + i * xStep;
    const y = padT + chartH * (1 - d.open / maxVal);
    return `${x},${y}`;
  });

  return (
    <div className="mt-4 bg-white border border-zinc-200 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-zinc-900 mb-2">Open Debt Trend — Last 8 Weeks</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" style={{ height: H }} aria-hidden="true">
        {[0, 0.5, 1].map((frac) => {
          const y = padT + chartH * (1 - frac);
          return (
            <g key={frac}>
              <line x1={padL} x2={W - 4} y1={y} y2={y} stroke="#e4e4e7" strokeWidth={1} />
              <text x={padL - 3} y={y + 4} textAnchor="end" fontSize={9} fill="#71717a">
                {Math.round(maxVal * frac)}
              </text>
            </g>
          );
        })}
        {pts.length > 1 && (
          <polyline
            points={pts.join(" ")}
            fill="none"
            stroke="#dc2626"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {weekData.map((d, i) => {
          const x = padL + i * xStep;
          const y = padT + chartH * (1 - d.open / maxVal);
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={3} fill="#dc2626" />
              {i % 2 === 0 && (
                <text x={x} y={H - 4} textAnchor="middle" fontSize={9} fill="#71717a">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function DebtRegister({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<DebtItem[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [statusFilter, setStatusFilter] = useState("open");
  const [severityFilter, setSeverityFilter] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanServerId, setScanServerId] = useState("");
  const [showScanModal, setShowScanModal] = useState(false);
  const [editItem, setEditItem] = useState<DebtItem | null>(null);
  const [editStatus, setEditStatus] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForItem, setCreateForItem] = useState<DebtItem | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);

  function loadItems() {
    const params = new URLSearchParams({ projectId });
    if (statusFilter) params.set("status", statusFilter);
    if (severityFilter) params.set("severity", severityFilter);
    fetch(`/api/debt?${params}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setItems(d));
  }

  useEffect(() => { loadItems(); }, [projectId, statusFilter, severityFilter]);

  useEffect(() => {
    fetch("/api/servers")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Server[]) => {
        setServers(d);
        if (d.length > 0) setScanServerId(d[0].id);
      });
  }, []);

  async function handleScan() {
    if (!scanServerId) return;
    setScanning(true);
    setScanError(null);
    const res = await fetch(`/api/projects/${projectId}/debt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: scanServerId }),
    });
    setScanning(false);
    setShowScanModal(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setScanError(body.error ?? "Scan failed");
    } else {
      loadItems();
    }
  }

  async function handleStatusChange() {
    if (!editItem) return;
    setSavingEdit(true);
    await fetch(`/api/debt/${editItem.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: editStatus }),
    });
    setSavingEdit(false);
    setEditItem(null);
    loadItems();
  }

  async function handleCreateTask() {
    if (!createForItem || !taskTitle.trim()) return;
    setCreating(true);
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        title: taskTitle.trim(),
        description: `Resolve debt item: ${createForItem.title}\n\n${createForItem.description}\n\nSuggested action: ${(createForItem.evidence as { suggestedAction?: string })?.suggestedAction ?? ""}`.trim(),
        taskType: "maintenance",
        priority: createForItem.severity === "critical" ? "P1" : createForItem.severity === "high" ? "P2" : "P3",
      }),
    });
    setCreating(false);
    setCreateForItem(null);
    setTaskTitle("");
  }

  const openCount = items.filter((i) => i.status === "open").length;
  const criticalCount = items.filter((i) => i.severity === "critical" && i.status === "open").length;

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-zinc-900">Debt Register</h2>
          {openCount > 0 && (
            <span className="bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full border border-red-200">
              {openCount} open{criticalCount > 0 ? ` · ${criticalCount} critical` : ""}
            </span>
          )}
        </div>
        <Btn variant="secondary" size="sm" onClick={() => setShowScanModal(true)}>
          Run Debt Scan
        </Btn>
      </div>

      {scanError && (
        <p className="text-sm text-red-700 mb-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{scanError}</p>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 mb-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-xs border border-zinc-300 rounded-md px-2 py-1 text-zinc-700 bg-white focus:outline-none focus:ring-1 focus:ring-zinc-900"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="text-xs border border-zinc-300 rounded-md px-2 py-1 text-zinc-700 bg-white focus:outline-none focus:ring-1 focus:ring-zinc-900"
        >
          <option value="">All severities</option>
          {["critical", "high", "medium", "low"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Debt items list */}
      {items.length === 0 ? (
        <div className="bg-white border border-zinc-200 rounded-xl p-6 text-center">
          <p className="text-sm text-zinc-600">
            {statusFilter === "open" ? "No open debt items." : "No debt items matching these filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className={`bg-white border rounded-xl p-4 flex items-start gap-3 ${item.severity === "critical" ? "border-red-200" : item.severity === "high" ? "border-orange-200" : "border-zinc-200"}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <SeverityBadge severity={item.severity} />
                  <CategoryBadge category={item.category} />
                  <span className="text-xs text-zinc-500">{STATUS_LABEL[item.status]}</span>
                </div>
                <p className="text-sm font-medium text-zinc-900">{item.title}</p>
                <p className="text-xs text-zinc-600 mt-0.5 line-clamp-2">{item.description}</p>
                {item.evidence && (item.evidence as { source?: string }).source && (
                  <p className="text-xs text-zinc-500 mt-1 italic">
                    Evidence: {(item.evidence as { source: string }).source}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <Btn
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEditItem(item); setEditStatus(item.status); }}
                >
                  Status
                </Btn>
                {item.status !== "resolved" && item.status !== "wont_fix" && (
                  <Btn
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setCreateForItem(item);
                      setTaskTitle(`Fix: ${item.title}`);
                    }}
                  >
                    Create Task
                  </Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Trend chart — show over all items regardless of filter */}
      <DebtTrendChart items={items} />

      {/* Scan modal */}
      {showScanModal && (
        <Modal title="Run Debt Scan" onClose={() => setShowScanModal(false)}>
          <p className="text-sm text-zinc-700 mb-4">
            Claude will analyse this project&apos;s task history to detect technical debt patterns.
          </p>
          <FormField label="Server">
            <select
              value={scanServerId}
              onChange={(e) => setScanServerId(e.target.value)}
              className={inputCls}
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </FormField>
          <ModalActions>
            <Btn variant="primary" onClick={handleScan} disabled={scanning || !scanServerId} className="flex-1">
              {scanning ? "Scanning…" : "Run Scan"}
            </Btn>
            <Btn variant="secondary" onClick={() => setShowScanModal(false)} className="flex-1">
              Cancel
            </Btn>
          </ModalActions>
        </Modal>
      )}

      {/* Edit status modal */}
      {editItem && (
        <Modal title="Update Debt Status" onClose={() => setEditItem(null)}>
          <p className="text-sm font-medium text-zinc-900 mb-4">{editItem.title}</p>
          <FormField label="Status">
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
              className={inputCls}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </FormField>
          <ModalActions>
            <Btn variant="primary" onClick={handleStatusChange} disabled={savingEdit} className="flex-1">
              {savingEdit ? "Saving…" : "Save"}
            </Btn>
            <Btn variant="secondary" onClick={() => setEditItem(null)} className="flex-1">
              Cancel
            </Btn>
          </ModalActions>
        </Modal>
      )}

      {/* Create task modal */}
      {createForItem && (
        <Modal title="Create Task to Resolve Debt" onClose={() => setCreateForItem(null)}>
          <p className="text-sm text-zinc-700 mb-4">
            Creates a maintenance task linked to this debt item.
          </p>
          <FormField label="Task Title">
            <input
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              className={inputCls}
              placeholder="Describe the fix…"
            />
          </FormField>
          <ModalActions>
            <Btn variant="primary" onClick={handleCreateTask} disabled={creating || !taskTitle.trim()} className="flex-1">
              {creating ? "Creating…" : "Create Task"}
            </Btn>
            <Btn variant="secondary" onClick={() => setCreateForItem(null)} className="flex-1">
              Cancel
            </Btn>
          </ModalActions>
        </Modal>
      )}
    </section>
  );
}
