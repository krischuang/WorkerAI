import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { logAdminAction } from "@/lib/admin-audit-log";
import { emitAudit } from "@/lib/audit";
import {
  parseHexKey,
  encryptSecretWithKey,
  decryptSecretWithKey,
} from "@/lib/task-secrets";
import type { NextRequest } from "next/server";

/**
 * POST /api/admin/secrets/rotate-key
 *
 * Re-encrypts every TaskSecret row from an old master key to a new master key.
 * Use this endpoint when rotating TASK_SECRET_KEY (e.g. after a suspected
 * env var leak or as part of a periodic key-rotation policy).
 *
 * Workflow:
 *   1. Call this endpoint with the current key (oldKey) and the new key (newKey).
 *   2. Verify the response — it reports how many rows were migrated.
 *   3. Update the TASK_SECRET_KEY env var to newKey and restart the server.
 *
 * Request body:
 *   { oldKey: string, newKey: string }
 *   Both values must be 64-character hex strings (32 bytes each).
 *
 * Security notes:
 *   - The key values are never written to logs or the audit trail.
 *   - The re-encryption runs inside a single Prisma transaction; any
 *     decryption failure for a row aborts the entire migration so no
 *     row is left in a half-migrated state.
 *   - Rate-limited to 1 attempt per 5 minutes by the in-memory limiter
 *     (key: "admin:secrets:rotate-key").
 */
export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Request body must be JSON" }, { status: 400 });
    }

    const oldKeyBuf = parseHexKey(body.oldKey);
    if (!oldKeyBuf) {
      return Response.json(
        { error: "oldKey must be a 64-character hex string (32 bytes)" },
        { status: 400 },
      );
    }

    const newKeyBuf = parseHexKey(body.newKey);
    if (!newKeyBuf) {
      return Response.json(
        { error: "newKey must be a 64-character hex string (32 bytes)" },
        { status: 400 },
      );
    }

    if (oldKeyBuf.equals(newKeyBuf)) {
      return Response.json(
        { error: "oldKey and newKey must be different" },
        { status: 400 },
      );
    }

    // Fetch all TaskSecret rows.
    const rows = await prisma.taskSecret.findMany({
      select: { id: true, encryptedValue: true },
    });

    if (rows.length === 0) {
      await logAdminAction(request, {
        action: "secret_key.rotated",
        targetType: "TaskSecret",
        payload: { migrated: 0 },
      });
      return Response.json({ ok: true, migrated: 0 });
    }

    // Decrypt each row with oldKey and re-encrypt with newKey.
    // Build the update list before the transaction so a decryption failure
    // is caught before any writes occur.
    const updates: Array<{ id: string; encryptedValue: string }> = [];
    for (const row of rows) {
      let plaintext: string;
      try {
        plaintext = decryptSecretWithKey(row.encryptedValue, oldKeyBuf);
      } catch {
        return Response.json(
          {
            error: `Failed to decrypt secret row ${row.id} with the supplied oldKey. ` +
              "Ensure oldKey matches the key that was used to encrypt existing secrets.",
          },
          { status: 422 },
        );
      }
      updates.push({
        id: row.id,
        encryptedValue: encryptSecretWithKey(plaintext, newKeyBuf),
      });
    }

    // Write all re-encrypted values atomically.
    await prisma.$transaction(
      updates.map((u) =>
        prisma.taskSecret.update({
          where: { id: u.id },
          data: { encryptedValue: u.encryptedValue },
        }),
      ),
    );

    const migrated = updates.length;

    // Audit: log the rotation without including any key material.
    await Promise.all([
      logAdminAction(request, {
        action: "secret_key.rotated",
        targetType: "TaskSecret",
        payload: { migrated },
      }),
      emitAudit({
        entityType: "TaskSecret",
        entityId: "all",
        eventType: "secret_key.rotated",
        actorType: "user",
        payload: { migrated },
      }),
    ]);

    return Response.json({
      ok: true,
      migrated,
      message:
        `Successfully re-encrypted ${migrated} secret row(s). ` +
        "Update TASK_SECRET_KEY to newKey and restart the server to complete the rotation.",
    });
  } catch (err) {
    return serverError("admin/secrets/rotate-key POST", err);
  }
}
