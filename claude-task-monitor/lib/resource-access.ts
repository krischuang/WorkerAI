/**
 * Resource ownership / access validation helpers.
 *
 * Every read, update, and delete on a child resource (secrets, artifacts,
 * execution logs) must confirm the parent task exists before operating.
 * This prevents IDOR: knowing a task UUID should not be sufficient to
 * probe child resources on a different task.
 *
 * Since WorkerAI is single-user, the access model is:
 *   owner  — any authenticated session (general AUTH_SECRET cookie)
 *   admin  — requires the ADMIN_COOKIE in addition to owner auth
 *
 * Middleware already enforces authentication before any route handler runs.
 * These helpers only validate resource existence and parent→child binding.
 */

import { prisma } from "@/lib/prisma";

/** Minimal task record for ownership checks. */
export interface TaskAccessRecord {
  id: string;
  projectId: string;
}

/**
 * Validate that a task exists and return its minimal record.
 * Returns null if the task does not exist (caller should respond 404).
 */
export async function getTaskOrNull(taskId: string): Promise<TaskAccessRecord | null> {
  return prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true },
  });
}

/**
 * Validate that an artifact exists and belongs to the given task.
 * Returns null if the artifact does not exist or belongs to a different task.
 */
export async function getArtifactOrNull(
  artifactId: string,
  taskId: string,
): Promise<{ id: string; taskId: string } | null> {
  const artifact = await prisma.taskArtifact.findUnique({
    where: { id: artifactId },
    select: { id: true, taskId: true },
  });
  if (!artifact || artifact.taskId !== taskId) return null;
  return artifact;
}

/**
 * Validate that a task secret key belongs to the given task.
 * Returns null if the secret does not exist or belongs to a different task.
 */
export async function getTaskSecretOrNull(
  taskId: string,
  key: string,
): Promise<{ taskId: string; key: string } | null> {
  return prisma.taskSecret.findUnique({
    where: { taskId_key: { taskId, key } },
    select: { taskId: true, key: true },
  });
}
