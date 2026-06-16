/**
 * Explicit state-machine definition for Task.status.
 *
 * Centralises the allowed transitions so every enforcement point in the
 * codebase can import from here rather than re-deriving the rules inline.
 *
 * Used by:
 *   PUT /api/tasks/[id]/status  → guards manual status updates
 *   lib/task-dispatch.ts        → DISPATCHABLE_STATUSES tells the caller
 *                                  which states allow a new dispatch
 *   tasks/[id]/route.ts         → QUEUE_AUTO_ADVANCE_FROM tells the auto-
 *                                  advance path when pending → queued fires
 */

import type { TaskStatus } from "@/app/generated/prisma/client";

// ─── Transition table ─────────────────────────────────────────────────────────

/**
 * Every entry lists the states that `from` is ALLOWED to move to.
 * Transitions that are not listed here are invalid.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  pending:   new Set<TaskStatus>(["queued", "paused"]),
  queued:    new Set<TaskStatus>(["running", "pending", "paused"]),
  running:   new Set<TaskStatus>(["completed", "failed", "paused"]),
  paused:    new Set<TaskStatus>(["queued", "pending"]),
  completed:    new Set<TaskStatus>(["archived", "pending"]),
  failed:       new Set<TaskStatus>(["pending"]),
  archived:     new Set<TaskStatus>([]), // terminal state — no outbound transitions
  needs_review: new Set<TaskStatus>(["pending"]), // human must re-queue after review
};

/**
 * States from which a new dispatch (queued → running) is permitted.
 * Matches the guard in tryDispatchTaskToServer / tryDispatchTaskToAgent.
 */
export const DISPATCHABLE_STATUSES = new Set<TaskStatus>(["queued", "pending"]);

/**
 * The only state that triggers automatic advancement to "queued" when a
 * server or agent is assigned without an explicit status in the request body.
 */
export const QUEUE_AUTO_ADVANCE_FROM: TaskStatus = "pending";

// ─── Validators ───────────────────────────────────────────────────────────────

export type TransitionValidationError = {
  field: "status";
  message: string;
};

/**
 * Returns true when moving from `from` to `to` is a valid transition.
 * A no-op (from === to) is always valid.
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Returns a ValidationError when the transition is invalid, or null when it
 * is allowed (or a no-op).
 */
export function validateTransition(
  from: TaskStatus,
  to: TaskStatus,
): TransitionValidationError | null {
  if (isValidTransition(from, to)) return null;
  return {
    field: "status",
    message: `Invalid status transition: "${from}" → "${to}". ` +
      `Allowed next states: ${[...ALLOWED_TRANSITIONS[from]].join(", ") || "(none — terminal state)"}`,
  };
}

/**
 * Returns true when a task in `status` is eligible to be dispatched.
 */
export function isDispatchable(status: TaskStatus): boolean {
  return DISPATCHABLE_STATUSES.has(status);
}
