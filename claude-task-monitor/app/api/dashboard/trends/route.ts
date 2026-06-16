import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export interface TrendDay {
  date: string;   // YYYY-MM-DD
  completed: number;
  failed: number;
}

export interface ProjectSparkline {
  projectId: string;
  projectName: string;
  days: Array<{ date: string; completed: number }>;
}

export interface TrendsResponse {
  days: TrendDay[];
  projectSparklines: ProjectSparkline[];
  cachedAt: string;
}

const CACHE_KEY   = "dashboard_trends_cache";
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

async function buildTrends(): Promise<TrendsResponse> {
  // ── Daily completed/failed for the past 7 days ───────────────────────────
  const rows = await prisma.$queryRaw<
    Array<{ date: string; completed: bigint; failed: bigint }>
  >`
    SELECT
      TO_CHAR("finishedAt"::date, 'YYYY-MM-DD') AS date,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed
    FROM "ExecutionLog"
    WHERE "finishedAt" >= NOW() - INTERVAL '7 days'
      AND status IN ('completed', 'failed')
    GROUP BY "finishedAt"::date
    ORDER BY "finishedAt"::date ASC
  `;

  // Build a map keyed by date string, then fill all 7 buckets
  const byDate = new Map<string, { completed: number; failed: number }>();
  for (const r of rows) {
    byDate.set(r.date, {
      completed: Number(r.completed),
      failed:    Number(r.failed),
    });
  }

  const days: TrendDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, ...(byDate.get(key) ?? { completed: 0, failed: 0 }) });
  }

  // ── Per-project sparklines (completed tasks only) ────────────────────────
  const projRows = await prisma.$queryRaw<
    Array<{ projectId: string; projectName: string; date: string; completed: bigint }>
  >`
    SELECT
      t."projectId",
      p.name AS "projectName",
      TO_CHAR(el."finishedAt"::date, 'YYYY-MM-DD') AS date,
      COUNT(*) AS completed
    FROM "ExecutionLog" el
    INNER JOIN "Task" t ON t.id = el."taskId"
    INNER JOIN "Project" p ON p.id = t."projectId"
    WHERE el."finishedAt" >= NOW() - INTERVAL '7 days'
      AND el.status = 'completed'
    GROUP BY t."projectId", p.name, el."finishedAt"::date
    ORDER BY t."projectId", el."finishedAt"::date ASC
  `;

  // Collect per-project daily maps
  const projMap = new Map<string, { name: string; byDate: Map<string, number> }>();
  for (const r of projRows) {
    let entry = projMap.get(r.projectId);
    if (!entry) {
      entry = { name: r.projectName, byDate: new Map() };
      projMap.set(r.projectId, entry);
    }
    entry.byDate.set(r.date, Number(r.completed));
  }

  const dateBuckets = days.map(d => d.date);
  const projectSparklines: ProjectSparkline[] = [];
  for (const [projectId, { name, byDate }] of projMap) {
    projectSparklines.push({
      projectId,
      projectName: name,
      days: dateBuckets.map(date => ({ date, completed: byDate.get(date) ?? 0 })),
    });
  }
  // Sort by total completed descending
  projectSparklines.sort(
    (a, b) =>
      b.days.reduce((s, d) => s + d.completed, 0) -
      a.days.reduce((s, d) => s + d.completed, 0),
  );

  return { days, projectSparklines, cachedAt: new Date().toISOString() };
}

export async function GET(): Promise<NextResponse> {
  try {
    // Check cache
    const cached = await prisma.systemConfig.findUnique({
      where: { key: CACHE_KEY },
      select: { value: true, updatedAt: true },
    });

    if (cached?.value && cached.updatedAt) {
      const age = Date.now() - cached.updatedAt.getTime();
      if (age < CACHE_TTL_MS) {
        const data = JSON.parse(cached.value) as TrendsResponse;
        return NextResponse.json(data);
      }
    }

    const data = await buildTrends();

    await prisma.systemConfig.upsert({
      where: { key: CACHE_KEY },
      create: { key: CACHE_KEY, value: JSON.stringify(data) },
      update: { value: JSON.stringify(data) },
    });

    return NextResponse.json(data);
  } catch (err) {
    console.error("[trends] query failed:", err);
    return NextResponse.json({ error: "Failed to load trends" }, { status: 500 });
  }
}
