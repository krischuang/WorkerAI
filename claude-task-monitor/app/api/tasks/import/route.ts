import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { VALID_PRIORITIES, VALID_COST_LEVELS, VALID_TASK_TYPES } from "@/lib/task-validation";
import type { NextRequest } from "next/server";

// ── CSV parser (RFC 4180) ─────────────────────────────────────────────────────

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const row: string[] = [];

    while (true) {
      let cell = "";
      if (i < n && text[i] === '"') {
        // Quoted field — handles embedded commas, newlines, and escaped quotes.
        i++;
        while (i < n) {
          if (text[i] === '"') {
            if (i + 1 < n && text[i + 1] === '"') {
              cell += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            cell += text[i++];
          }
        }
      } else {
        while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          cell += text[i++];
        }
        cell = cell.trim();
      }

      row.push(cell);

      if (i < n && text[i] === ",") {
        i++;
      } else {
        break;
      }
    }

    if (i < n && text[i] === "\r") i++;
    if (i < n && text[i] === "\n") i++;

    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
  }

  return rows;
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/tasks/import?projectId=<id>
 *
 * Accepts multipart/form-data with a 'file' field (CSV).
 * Expected columns (case-insensitive): title (required), description,
 * priority (P1-P4, default P3), taskType, estimatedCostLevel, timeoutMinutes.
 * Unknown columns are ignored.
 *
 * Returns { created: N, skipped: N, errors: [{ row, message }] }.
 */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return Response.json(
        { error: "projectId query param is required" },
        { status: 400 },
      );
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return Response.json(
        { error: "Request must be multipart/form-data" },
        { status: 400 },
      );
    }

    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return Response.json(
        { error: "file field is required (multipart/form-data)" },
        { status: 400 },
      );
    }

    const text = await (file as File).text();
    const rows = parseCSV(text);

    if (rows.length < 2) {
      return Response.json(
        { error: "CSV must have a header row and at least one data row" },
        { status: 400 },
      );
    }

    // Normalise header names for case-insensitive lookup.
    const headers = rows[0].map((h) => h.toLowerCase().trim().replace(/\s+/g, ""));
    const col = (name: string) => headers.indexOf(name);

    const idxTitle              = col("title");
    const idxDescription        = col("description");
    const idxPriority           = col("priority");
    const idxTaskType           = col("tasktype");
    const idxEstimatedCostLevel = col("estimatedcostlevel");
    const idxTimeoutMinutes     = col("timeoutminutes");

    if (idxTitle === -1) {
      return Response.json(
        { error: "CSV must contain a 'title' column" },
        { status: 400 },
      );
    }

    const errors: { row: number; message: string }[] = [];
    const toCreate: {
      projectId: string;
      title: string;
      description: string | null;
      priority: string;
      taskType: string;
      estimatedCostLevel: string;
      timeoutMinutes?: number;
    }[] = [];

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rowNum = r + 1; // 1-based; header occupies row 1

      const get = (idx: number) => (idx !== -1 ? row[idx]?.trim() ?? "" : "");

      const title = get(idxTitle);
      if (!title) {
        errors.push({ row: rowNum, message: "title is required" });
        continue;
      }
      if (title.length > 500) {
        errors.push({ row: rowNum, message: "title exceeds 500 characters" });
        continue;
      }

      const description = get(idxDescription) || null;
      if (description && description.length > 10_000) {
        errors.push({ row: rowNum, message: "description exceeds 10 000 characters" });
        continue;
      }

      const rawPriority = get(idxPriority).toUpperCase();
      const priority =
        rawPriority && VALID_PRIORITIES.has(rawPriority) ? rawPriority : "P3";

      const rawTaskType = get(idxTaskType).toLowerCase();
      const taskType =
        rawTaskType && VALID_TASK_TYPES.has(rawTaskType) ? rawTaskType : "coding";

      const rawCostLevel = get(idxEstimatedCostLevel).toLowerCase();
      const estimatedCostLevel =
        rawCostLevel && VALID_COST_LEVELS.has(rawCostLevel) ? rawCostLevel : "medium";

      let timeoutMinutes: number | undefined;
      const rawTimeout = get(idxTimeoutMinutes);
      if (rawTimeout) {
        const n = Number(rawTimeout);
        if (!isNaN(n) && n > 0) timeoutMinutes = Math.round(n);
      }

      toCreate.push({
        projectId,
        title,
        description,
        priority,
        taskType,
        estimatedCostLevel,
        ...(timeoutMinutes != null && { timeoutMinutes }),
      });
    }

    let created = 0;
    if (toCreate.length > 0) {
      const result = await prisma.task.createMany({
        data: toCreate as never,
      });
      created = result.count;
    }

    return Response.json({ created, skipped: errors.length, errors });
  } catch (err) {
    return serverError("tasks/import POST", err);
  }
}
