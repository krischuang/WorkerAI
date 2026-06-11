import { DEFAULT_TASK_TIMEOUT_MIN } from "@/lib/constants";

/**
 * Resolve the effective timeout for a task.
 * Priority: task.timeoutMinutes → server/agent defaultTaskTimeoutMinutes → global default.
 */
export function resolveTaskTimeout(
  taskTimeoutMinutes: number | null | undefined,
  serverDefault: number | null | undefined,
  agentDefault: number | null | undefined,
): number {
  if (taskTimeoutMinutes != null) return taskTimeoutMinutes;
  if (serverDefault != null) return serverDefault;
  if (agentDefault != null) return agentDefault;
  return DEFAULT_TASK_TIMEOUT_MIN;
}

/**
 * Compute the wall-clock deadline for a running task.
 */
export function computeTimeoutExpiresAt(startedAt: Date, timeoutMinutes: number): string {
  return new Date(startedAt.getTime() + timeoutMinutes * 60_000).toISOString();
}
