import { DEFAULT_TASK_TIMEOUT_MIN } from "@/lib/constants";

export type TaskTypeKey = "coding" | "research" | "writing" | "review" | "maintenance";

/** Maps each TaskType to its SystemConfig key. */
export const TASK_TYPE_TIMEOUT_KEYS: Record<TaskTypeKey, string> = {
  coding:      "timeout_coding_minutes",
  research:    "timeout_research_minutes",
  writing:     "timeout_writing_minutes",
  review:      "timeout_review_minutes",
  maintenance: "timeout_maintenance_minutes",
};

/**
 * Resolve the effective timeout for a task.
 * Priority: task.timeoutMinutes → server/agent default → taskTypeDefault → global default.
 */
export function resolveTaskTimeout(
  taskTimeoutMinutes: number | null | undefined,
  serverDefault: number | null | undefined,
  agentDefault: number | null | undefined,
  taskTypeDefault?: number | null,
): number {
  if (taskTimeoutMinutes != null) return taskTimeoutMinutes;
  if (serverDefault != null) return serverDefault;
  if (agentDefault != null) return agentDefault;
  if (taskTypeDefault != null) return taskTypeDefault;
  return DEFAULT_TASK_TIMEOUT_MIN;
}

/**
 * Compute the wall-clock deadline for a running task.
 */
export function computeTimeoutExpiresAt(startedAt: Date, timeoutMinutes: number): string {
  return new Date(startedAt.getTime() + timeoutMinutes * 60_000).toISOString();
}
