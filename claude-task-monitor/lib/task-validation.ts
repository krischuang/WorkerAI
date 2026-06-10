/**
 * Pure validation functions for task API routes.
 * Extracted so they can be unit-tested without a running HTTP server or DB.
 *
 * Used by:
 *   POST   /api/tasks              → validateTaskCreate
 *   PUT    /api/tasks/[id]         → validateTaskUpdate
 *   PUT    /api/tasks/[id]/status  → validateStatusUpdate
 */

import { Priority, TaskStatus, CostLevel, TaskType } from "@/app/generated/prisma/enums";

export type ValidationError = { field: string; message: string };

const VALID_PRIORITIES  = new Set<string>(Object.values(Priority));
const VALID_STATUSES    = new Set<string>(Object.values(TaskStatus));
const VALID_COST_LEVELS = new Set<string>(Object.values(CostLevel));
const VALID_TASK_TYPES  = new Set<string>(Object.values(TaskType));

export { VALID_PRIORITIES, VALID_STATUSES, VALID_COST_LEVELS, VALID_TASK_TYPES };

// ─── Task create (POST /api/tasks) ────────────────────────────────────────────

export function validateTaskCreate(body: Record<string, unknown>): ValidationError | null {
  const { projectId, title, description, priority, status, estimatedCostLevel, taskType } = body;

  if (!projectId || !title) {
    return { field: "projectId/title", message: "projectId and title are required" };
  }
  if (typeof title === "string" && title.length > 500) {
    return { field: "title", message: "title must be 500 characters or fewer" };
  }
  if (description != null && typeof description === "string" && description.length > 10_000) {
    return { field: "description", message: "description must be 10 000 characters or fewer" };
  }
  return _validateEnumFields({ priority, status, estimatedCostLevel, taskType });
}

// ─── Task update (PUT /api/tasks/[id]) ───────────────────────────────────────

export function validateTaskUpdate(body: Record<string, unknown>): ValidationError | null {
  const { title, description, priority, status, estimatedCostLevel, taskType } = body;

  if (title != null && typeof title === "string" && title.length > 500) {
    return { field: "title", message: "title must be 500 characters or fewer" };
  }
  if (description != null && typeof description === "string" && description.length > 10_000) {
    return { field: "description", message: "description must be 10 000 characters or fewer" };
  }
  return _validateEnumFields({ priority, status, estimatedCostLevel, taskType });
}

// ─── Status-only update (PUT /api/tasks/[id]/status) ─────────────────────────

export function validateStatusUpdate(status: unknown): ValidationError | null {
  if (!status) {
    return { field: "status", message: "status is required" };
  }
  if (!VALID_STATUSES.has(status as string)) {
    return {
      field: "status",
      message: `Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(", ")}`,
    };
  }
  return null;
}

// ─── Shared enum field validator ──────────────────────────────────────────────

function _validateEnumFields(fields: {
  priority?: unknown;
  status?: unknown;
  estimatedCostLevel?: unknown;
  taskType?: unknown;
}): ValidationError | null {
  const { priority, status, estimatedCostLevel, taskType } = fields;

  if (priority != null && !VALID_PRIORITIES.has(priority as string)) {
    return {
      field: "priority",
      message: `Invalid priority. Must be one of: ${[...VALID_PRIORITIES].join(", ")}`,
    };
  }
  if (status != null && !VALID_STATUSES.has(status as string)) {
    return {
      field: "status",
      message: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}`,
    };
  }
  if (estimatedCostLevel != null && !VALID_COST_LEVELS.has(estimatedCostLevel as string)) {
    return {
      field: "estimatedCostLevel",
      message: `Invalid estimatedCostLevel. Must be one of: ${[...VALID_COST_LEVELS].join(", ")}`,
    };
  }
  if (taskType != null && !VALID_TASK_TYPES.has(taskType as string)) {
    return {
      field: "taskType",
      message: `Invalid taskType. Must be one of: ${[...VALID_TASK_TYPES].join(", ")}`,
    };
  }
  return null;
}
