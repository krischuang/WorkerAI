import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";

export interface AdminAuditInput {
  action: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

/** Extract the best available actor identifier from an incoming request. */
function extractActor(request: NextRequest | Request): string {
  const req = request as NextRequest;
  const forwarded = req.headers?.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const real = req.headers?.get("x-real-ip");
  if (real) return real;
  return "admin";
}

/**
 * Write an admin audit log entry. Never throws — failures are logged
 * to stderr so a broken audit write never breaks the primary operation.
 */
export async function logAdminAction(
  request: NextRequest | Request,
  input: AdminAuditInput,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actor: extractActor(request),
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        payload: (input.payload ?? {}) as never,
      },
    });
  } catch (err) {
    console.error("[admin-audit] write failed:", err);
  }
}
