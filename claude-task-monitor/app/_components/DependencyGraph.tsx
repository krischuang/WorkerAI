"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GraphTask {
  id: string;
  title: string;
  status: string;
}

interface GraphEdge {
  taskId: string;      // downstream (dependent)
  dependsOnId: string; // upstream (prerequisite)
}

interface GraphData {
  tasks: GraphTask[];
  edges: GraphEdge[];
}

interface NodeLayout {
  id: string;
  title: string;
  status: string;
  x: number;
  y: number;
}

// ── Status colours ────────────────────────────────────────────────────────────

const STATUS_FILL: Record<string, string> = {
  pending:   "#f4f4f5",
  queued:    "#ede9fe",
  running:   "#dbeafe",
  paused:    "#fef3c7",
  completed: "#dcfce7",
  failed:    "#fee2e2",
  archived:  "#f1f5f9",
};

const STATUS_STROKE: Record<string, string> = {
  pending:   "#71717a",
  queued:    "#7c3aed",
  running:   "#2563eb",
  paused:    "#d97706",
  completed: "#16a34a",
  failed:    "#dc2626",
  archived:  "#94a3b8",
};

const STATUS_TEXT: Record<string, string> = {
  pending:   "#52525b",
  queued:    "#5b21b6",
  running:   "#1d4ed8",
  paused:    "#92400e",
  completed: "#15803d",
  failed:    "#b91c1c",
  archived:  "#475569",
};

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W = 168;
const NODE_H = 54;
const H_GAP  = 72;  // horizontal gap between columns
const V_GAP  = 20;  // vertical gap between nodes in same column
const PAD    = 28;

// ── DAG layer-assignment ──────────────────────────────────────────────────────
// edges: dependsOnId → taskId (upstream → downstream)
// A node's layer = max(layer of predecessors) + 1.

function layoutGraph(tasks: GraphTask[], edges: GraphEdge[]): {
  nodes: NodeLayout[];
  svgWidth: number;
  svgHeight: number;
} {
  if (tasks.length === 0) return { nodes: [], svgWidth: 0, svgHeight: 0 };

  // Build predecessor sets
  const predecessors = new Map<string, Set<string>>();
  const successors   = new Map<string, Set<string>>();
  for (const t of tasks) { predecessors.set(t.id, new Set()); successors.set(t.id, new Set()); }
  for (const e of edges) {
    predecessors.get(e.taskId)?.add(e.dependsOnId);
    successors.get(e.dependsOnId)?.add(e.taskId);
  }

  // Kahn + longest-path layer assignment
  const inDegree = new Map<string, number>();
  for (const t of tasks) inDegree.set(t.id, predecessors.get(t.id)!.size);

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const t of tasks) {
    if (inDegree.get(t.id) === 0) { layer.set(t.id, 0); queue.push(t.id); }
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curLayer = layer.get(cur) ?? 0;
    for (const suc of (successors.get(cur) ?? [])) {
      const next = curLayer + 1;
      if ((layer.get(suc) ?? -1) < next) layer.set(suc, next);
      const deg = (inDegree.get(suc) ?? 1) - 1;
      inDegree.set(suc, deg);
      if (deg <= 0) queue.push(suc);
    }
  }

  // Nodes not reached (cycle remnants) get their own column
  const maxLayer = Math.max(0, ...Array.from(layer.values()));
  for (const t of tasks) if (!layer.has(t.id)) layer.set(t.id, maxLayer + 1);

  // Group by layer (preserve original task order within each layer)
  const byLayer = new Map<number, GraphTask[]>();
  for (const t of tasks) {
    const l = layer.get(t.id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(t);
  }

  // Assign (x, y) coordinates
  const colCount = Math.max(...Array.from(byLayer.keys())) + 1;
  const svgWidth = PAD + colCount * (NODE_W + H_GAP) - H_GAP + PAD;

  let maxColHeight = 0;
  const nodes: NodeLayout[] = [];

  for (const [l, col] of Array.from(byLayer.entries()).sort(([a], [b]) => a - b)) {
    const colH = col.length * (NODE_H + V_GAP) - V_GAP;
    maxColHeight = Math.max(maxColHeight, colH);
    for (let i = 0; i < col.length; i++) {
      nodes.push({
        id: col[i].id,
        title: col[i].title,
        status: col[i].status,
        x: PAD + l * (NODE_W + H_GAP),
        y: PAD + i * (NODE_H + V_GAP),
      });
    }
  }

  return { nodes, svgWidth, svgHeight: PAD + maxColHeight + PAD };
}

// ── Main component ────────────────────────────────────────────────────────────

export function DependencyGraph({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [data,    setData]    = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/projects/${projectId}/graph`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: GraphData) => { setData(d); setLoading(false); })
      .catch(() => { setError("Failed to load graph"); setLoading(false); });
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <p className="text-sm text-zinc-600 py-10 text-center">Loading graph…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-700 py-10 text-center">{error}</p>;
  }
  if (!data || data.tasks.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-zinc-200 p-8 text-center">
        <p className="text-sm text-zinc-600">No tasks in this project yet.</p>
      </div>
    );
  }

  // If no edges, show a simple chip list with a hint
  if (data.edges.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-zinc-200 p-6">
        <p className="text-sm text-zinc-600 mb-4">
          No dependencies defined. Open a task to add prerequisites.
        </p>
        <div className="flex flex-wrap gap-2">
          {data.tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => router.push(`/tasks/${t.id}`)}
              style={{
                background:   STATUS_FILL[t.status]   ?? STATUS_FILL.pending,
                borderColor:  STATUS_STROKE[t.status] ?? STATUS_STROKE.pending,
                color:        STATUS_TEXT[t.status]   ?? STATUS_TEXT.pending,
              }}
              className="border rounded-lg px-3 py-1.5 text-xs font-medium hover:opacity-75 transition-opacity max-w-[200px] truncate"
              title={t.title}
            >
              {t.title}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const { nodes, svgWidth, svgHeight } = layoutGraph(data.tasks, data.edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-4">
      <p className="text-xs text-zinc-500 mb-3 select-none">
        Arrows flow prerequisite → dependent. Click a node to open the task.
      </p>

      <div className="overflow-x-auto">
        <svg
          width={svgWidth}
          height={svgHeight}
          className="block"
          style={{ minWidth: Math.min(svgWidth, 400) }}
        >
          <defs>
            <marker
              id="dag-arrow"
              markerWidth="8"
              markerHeight="6"
              refX="7"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill="#94a3b8" />
            </marker>
          </defs>

          {/* ── Edges ─────────────────────────────────────────────────────── */}
          {data.edges.map((e) => {
            const from = nodeMap.get(e.dependsOnId);
            const to   = nodeMap.get(e.taskId);
            if (!from || !to) return null;

            // Depart from right-centre of upstream, arrive at left-centre of downstream
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;

            return (
              <path
                key={`${e.dependsOnId}→${e.taskId}`}
                d={`M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`}
                fill="none"
                stroke="#94a3b8"
                strokeWidth={1.5}
                markerEnd="url(#dag-arrow)"
              />
            );
          })}

          {/* ── Nodes ─────────────────────────────────────────────────────── */}
          {nodes.map((n) => {
            const fill   = STATUS_FILL[n.status]   ?? STATUS_FILL.pending;
            const stroke = STATUS_STROKE[n.status] ?? STATUS_STROKE.pending;
            const text   = STATUS_TEXT[n.status]   ?? STATUS_TEXT.pending;
            const label  = n.title.length > 22 ? `${n.title.slice(0, 20)}…` : n.title;

            return (
              <g
                key={n.id}
                onClick={() => router.push(`/tasks/${n.id}`)}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`Open task: ${n.title}`}
                onKeyDown={(ev) => { if (ev.key === "Enter") router.push(`/tasks/${n.id}`); }}
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={1.5}
                  className="hover:opacity-75 transition-opacity"
                />
                {/* Title */}
                <text
                  x={n.x + NODE_W / 2}
                  y={n.y + NODE_H / 2 - 7}
                  textAnchor="middle"
                  fill={text}
                  fontSize={11}
                  fontWeight={600}
                  fontFamily="system-ui, sans-serif"
                >
                  {label}
                </text>
                {/* Status */}
                <text
                  x={n.x + NODE_W / 2}
                  y={n.y + NODE_H / 2 + 9}
                  textAnchor="middle"
                  fill={text}
                  fontSize={10}
                  fontFamily="system-ui, sans-serif"
                  opacity={0.75}
                >
                  {n.status}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
