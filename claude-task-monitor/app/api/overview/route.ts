import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export interface ProjectOverview {
  projectId: string;
  projectName: string;
  priority: string;
  projectStatus: string;
  taskCounts: {
    pending: number;
    running: number;
    failed: number;
  };
  oldestRunningTaskMinutes: number;
  activeAgents: number;
}

export async function GET(): Promise<NextResponse> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        projectId: string;
        projectName: string;
        priority: string;
        projectStatus: string;
        pendingCount: bigint;
        runningCount: bigint;
        failedCount: bigint;
        oldestRunningMinutes: number | null;
        activeAgents: bigint;
      }>
    >`
      SELECT
        p.id                                           AS "projectId",
        p.name                                         AS "projectName",
        p.priority::text                               AS "priority",
        p.status::text                                 AS "projectStatus",
        COUNT(t.id) FILTER (WHERE t.status = 'pending')  AS "pendingCount",
        COUNT(t.id) FILTER (WHERE t.status = 'running')  AS "runningCount",
        COUNT(t.id) FILTER (WHERE t.status = 'failed')   AS "failedCount",
        COALESCE(
          MAX(CASE WHEN t.status = 'running'
            THEN EXTRACT(EPOCH FROM (NOW() - t."updatedAt")) / 60.0
          END),
          0
        )                                              AS "oldestRunningMinutes",
        COUNT(DISTINCT t."agentId") FILTER (
          WHERE t.status = 'running' AND t."agentId" IS NOT NULL
        )                                              AS "activeAgents"
      FROM "Project" p
      LEFT JOIN "Task" t ON t."projectId" = p.id
      WHERE p.status != 'archived'
      GROUP BY p.id, p.name, p.priority, p.status
      ORDER BY p.priority ASC, p.name ASC
    `;

    const data: ProjectOverview[] = rows.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      priority: r.priority,
      projectStatus: r.projectStatus,
      taskCounts: {
        pending: Number(r.pendingCount),
        running: Number(r.runningCount),
        failed:  Number(r.failedCount),
      },
      oldestRunningTaskMinutes: Math.round(Number(r.oldestRunningMinutes ?? 0)),
      activeAgents: Number(r.activeAgents),
    }));

    return NextResponse.json(data);
  } catch (err) {
    console.error("[overview] query failed:", err);
    return NextResponse.json({ error: "Failed to load overview" }, { status: 500 });
  }
}
