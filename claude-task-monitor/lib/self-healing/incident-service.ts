import { prisma } from "@/lib/prisma";
import type { IncidentSeverity, IncidentStatus } from "@/app/generated/prisma/client";

export interface IncidentInput {
  source: string;
  severity: IncidentSeverity;
  affectedAgentId?: string;
  title: string;
  message: string;
  rawError?: string;
  contextJson?: Record<string, unknown>;
}

/** Create an incident only if no open/investigating one exists for the same source+agent. */
export async function createIncidentIfNew(
  input: IncidentInput,
): Promise<{ incidentId: string; isNew: boolean }> {
  const existing = await prisma.incident.findFirst({
    where: {
      source: input.source,
      affectedAgentId: input.affectedAgentId ?? null,
      status: { in: ["open", "investigating"] },
    },
    select: { id: true },
  });

  if (existing) return { incidentId: existing.id, isNew: false };

  const incident = await prisma.incident.create({
    data: {
      source: input.source,
      severity: input.severity,
      affectedAgentId: input.affectedAgentId ?? null,
      title: input.title,
      message: input.message,
      rawError: input.rawError ?? null,
      contextJson: (input.contextJson ?? {}) as never,
      status: "open",
    },
    select: { id: true },
  });

  return { incidentId: incident.id, isNew: true };
}

export async function resolveIncident(incidentId: string): Promise<void> {
  await prisma.incident.update({
    where: { id: incidentId },
    data: { status: "resolved", resolvedAt: new Date() },
  });
}

export async function setIncidentStatus(
  incidentId: string,
  status: IncidentStatus,
): Promise<void> {
  await prisma.incident.update({
    where: { id: incidentId },
    data: {
      status,
      ...(status === "resolved" ? { resolvedAt: new Date() } : {}),
    },
  });
}
