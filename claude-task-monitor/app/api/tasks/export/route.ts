import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote cells that contain commas, quotes, or newlines.
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

const CSV_HEADERS = [
  "id",
  "title",
  "description",
  "priority",
  "status",
  "taskType",
  "estimatedCostLevel",
  "projectId",
  "projectName",
  "createdAt",
  "updatedAt",
  "runCount",
  "lastRunAt",
  "lastRunStatus",
  "lastRunDurationMs",
  "lastRunError",
];

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/tasks/export?format=csv|json&projectId=<id>&status=<status>
 *
 * Streams all matching tasks with their execution logs.
 * JSON: nested executionLogs array per task.
 * CSV: one row per task; last execution log flattened.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const format    = searchParams.get("format") ?? "json";
    const projectId = searchParams.get("projectId") ?? "";
    const status    = searchParams.get("status")    ?? "";

    if (format !== "csv" && format !== "json") {
      return Response.json({ error: "format must be csv or json" }, { status: 400 });
    }

    const tasks = await prisma.task.findMany({
      where: {
        ...(projectId && projectId !== "all" && { projectId }),
        ...(status    && status !== "all"    && { status: status as never }),
      },
      include: {
        project: { select: { name: true } },
        executionLogs: {
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            durationMs: true,
            outputSummary: true,
            errorMessage: true,
          },
          orderBy: { startedAt: "desc" },
        },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });

    const ts        = new Date().toISOString().slice(0, 16).replace(/:/g, "-");
    const basename  = `tasks-export-${ts}`;

    if (format === "json") {
      const payload = tasks.map((t) => ({
        id:                 t.id,
        title:              t.title,
        description:        t.description,
        priority:           t.priority,
        status:             t.status,
        taskType:           t.taskType,
        estimatedCostLevel: t.estimatedCostLevel,
        projectId:          t.projectId,
        projectName:        t.project?.name ?? null,
        createdAt:          t.createdAt,
        updatedAt:          t.updatedAt,
        executionLogs:      t.executionLogs,
      }));

      return new Response(JSON.stringify(payload, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${basename}.json"`,
        },
      });
    }

    // ── CSV ────────────────────────────────────────────────────────────────
    const lines: string[] = [csvRow(CSV_HEADERS)];

    for (const t of tasks) {
      const last = t.executionLogs[0] ?? null;
      lines.push(
        csvRow([
          t.id,
          t.title,
          t.description,
          t.priority,
          t.status,
          t.taskType,
          t.estimatedCostLevel,
          t.projectId,
          t.project?.name ?? "",
          t.createdAt.toISOString(),
          t.updatedAt.toISOString(),
          t.executionLogs.length,
          last?.startedAt?.toISOString() ?? "",
          last?.status ?? "",
          last?.durationMs ?? "",
          last?.errorMessage ?? "",
        ]),
      );
    }

    return new Response(lines.join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${basename}.csv"`,
      },
    });
  } catch (err) {
    return serverError("tasks/export GET", err);
  }
}
