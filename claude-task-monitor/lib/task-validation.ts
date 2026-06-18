/**
 * Pure validation functions for task API routes.
 * Extracted so they can be unit-tested without a running HTTP server or DB.
 *
 * Used by:
 *   POST   /api/tasks              → validateTaskCreate
 *   PUT    /api/tasks/[id]         → validateTaskUpdate
 *   PUT    /api/tasks/[id]/status  → validateStatusUpdate
 *   POST   /api/agents             → validateTmuxSession, validateWorkDir
 *   PUT    /api/agents/[id]        → validateTmuxSession, validateWorkDir
 */

import { Priority, TaskStatus, CostLevel, TaskType } from "@/app/generated/prisma/enums";

export type ValidationError = { field: string; message: string };

const VALID_PRIORITIES  = new Set<string>(Object.values(Priority));
const VALID_STATUSES    = new Set<string>(Object.values(TaskStatus));
const VALID_COST_LEVELS = new Set<string>(Object.values(CostLevel));
const VALID_TASK_TYPES  = new Set<string>(Object.values(TaskType));

export { VALID_PRIORITIES, VALID_STATUSES, VALID_COST_LEVELS, VALID_TASK_TYPES };

// ─── tmuxSession and workDir validators ──────────────────────────────────────

/** Allowed tmux session name characters: alphanumeric, dot, underscore, hyphen. Max 64 chars. */
export const TMUX_SESSION_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/** Allowed working directory: absolute path, no quotes, no shell metacharacters. Max 255 chars. */
export const WORK_DIR_PATTERN = /^\/[a-zA-Z0-9._\-/]{0,254}$/;

/**
 * Validates a tmux session name.
 * Rejects any value that could be used for command injection when the name is
 * interpolated into shell commands like `tmux has-session -t <session>`.
 */
export function validateTmuxSession(value: unknown): ValidationError | null {
  if (typeof value !== "string" || !TMUX_SESSION_PATTERN.test(value)) {
    return {
      field: "tmuxSession",
      message: "tmuxSession must contain only alphanumeric characters, dots, underscores, or hyphens (max 64 chars)",
    };
  }
  return null;
}

/**
 * Validates a working directory path.
 * Rejects relative paths, quotes, and shell metacharacters to prevent
 * command injection when the value is used in shell scripts or SSH commands.
 */
export function validateWorkDir(value: unknown): ValidationError | null {
  if (typeof value !== "string" || !WORK_DIR_PATTERN.test(value)) {
    return {
      field: "workDir",
      message: "workDir must be an absolute path containing only alphanumeric characters, dots, hyphens, underscores, or slashes (max 255 chars)",
    };
  }
  return null;
}

/** Valid range for timeoutMinutes: 1 – 1440 (1 minute to 24 hours). */
export const TIMEOUT_MINUTES_MIN = 1;
export const TIMEOUT_MINUTES_MAX = 1440;

/** Valid range for maxRetries: 0 – 10. */
export const MAX_RETRIES_MIN = 0;
export const MAX_RETRIES_MAX = 10;

// ─── Task create (POST /api/tasks) ────────────────────────────────────────────

export function validateTaskCreate(body: Record<string, unknown>): ValidationError | null {
  const { projectId, title, description, priority, status, estimatedCostLevel, taskType,
          timeoutMinutes, maxRetries } = body;

  if (!projectId || !title) {
    return { field: "projectId/title", message: "projectId and title are required" };
  }
  if (typeof title === "string" && title.length > 500) {
    return { field: "title", message: "title must be 500 characters or fewer" };
  }
  if (description != null && typeof description === "string" && description.length > 10_000) {
    return { field: "description", message: "description must be 10 000 characters or fewer" };
  }
  const numErr = _validateNumericFields({ timeoutMinutes, maxRetries });
  if (numErr) return numErr;
  return _validateEnumFields({ priority, status, estimatedCostLevel, taskType });
}

// ─── Task update (PUT /api/tasks/[id]) ───────────────────────────────────────

export function validateTaskUpdate(body: Record<string, unknown>): ValidationError | null {
  const { title, description, priority, status, estimatedCostLevel, taskType,
          timeoutMinutes, maxRetries } = body;

  if (title != null && typeof title === "string" && title.length > 500) {
    return { field: "title", message: "title must be 500 characters or fewer" };
  }
  if (description != null && typeof description === "string" && description.length > 10_000) {
    return { field: "description", message: "description must be 10 000 characters or fewer" };
  }
  const numErr = _validateNumericFields({ timeoutMinutes, maxRetries });
  if (numErr) return numErr;
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

// ─── Automation / autonomousMode validator ────────────────────────────────────

/** Valid automation levels: 0 (off) through 4 (full autonomous with high-risk). */
export const AUTOMATION_LEVEL_MIN = 0;
export const AUTOMATION_LEVEL_MAX = 4;

/**
 * Validates an automationLevel / autonomousMode value.
 * Must be an integer in [0, 4]. Rejects NaN, decimals, negatives, and large integers.
 */
export function validateAutomationLevel(value: unknown, fieldName = "automationLevel"): ValidationError | null {
  if (value === undefined || value === null) return null;
  // Reject non-numeric types (strings, booleans, objects) at the type level.
  if (typeof value !== "number") {
    return {
      field: fieldName,
      message: `${fieldName} must be an integer between ${AUTOMATION_LEVEL_MIN} and ${AUTOMATION_LEVEL_MAX}`,
    };
  }
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < AUTOMATION_LEVEL_MIN ||
    value > AUTOMATION_LEVEL_MAX
  ) {
    return {
      field: fieldName,
      message: `${fieldName} must be an integer between ${AUTOMATION_LEVEL_MIN} and ${AUTOMATION_LEVEL_MAX}`,
    };
  }
  return null;
}

// ─── Shared numeric field validator ──────────────────────────────────────────

function _validateNumericFields(fields: {
  timeoutMinutes?: unknown;
  maxRetries?: unknown;
}): ValidationError | null {
  const { timeoutMinutes, maxRetries } = fields;

  if (timeoutMinutes != null) {
    const n = Number(timeoutMinutes);
    if (!Number.isInteger(n) || n < TIMEOUT_MINUTES_MIN || n > TIMEOUT_MINUTES_MAX) {
      return {
        field: "timeoutMinutes",
        message: `timeoutMinutes must be an integer between ${TIMEOUT_MINUTES_MIN} and ${TIMEOUT_MINUTES_MAX}`,
      };
    }
  }

  if (maxRetries != null) {
    const n = Number(maxRetries);
    if (!Number.isInteger(n) || n < MAX_RETRIES_MIN || n > MAX_RETRIES_MAX) {
      return {
        field: "maxRetries",
        message: `maxRetries must be an integer between ${MAX_RETRIES_MIN} and ${MAX_RETRIES_MAX}`,
      };
    }
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
