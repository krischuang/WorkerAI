import { prisma } from "./prisma";

export interface AuditInput {
  entityType: string;
  entityId: string;
  eventType: string;
  actorType?: string;
  payload?: Record<string, unknown>;
}

export async function emitAudit(event: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        entityType: event.entityType,
        entityId: event.entityId,
        eventType: event.eventType,
        actorType: event.actorType ?? "system",
        payload: (event.payload ?? {}) as never,
      },
    });
  } catch (err) {
    console.error("[audit] emit failed:", err);
  }
}
