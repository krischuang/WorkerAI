/**
 * AES-256-GCM encryption for per-task secret values.
 *
 * The master key is read from the TASK_SECRET_KEY environment variable, which
 * must be a 64-character hex string (32 bytes).  Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Encoded format (base64url): <12-byte IV> + <16-byte auth tag> + <ciphertext>
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getMasterKey(): Buffer {
  const raw = process.env.TASK_SECRET_KEY ?? "";
  if (!raw) throw new Error("TASK_SECRET_KEY env var is not set");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error("TASK_SECRET_KEY must be 64 hex chars (32 bytes)");
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  return encryptSecretWithKey(plaintext, key);
}

export function decryptSecret(encryptedValue: string): string {
  const key = getMasterKey();
  return decryptSecretWithKey(encryptedValue, key);
}

/**
 * Encrypt using an explicitly supplied 32-byte key buffer.
 * Used by the key-rotation endpoint so it does not need to swap the env var.
 */
export function encryptSecretWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64url");
}

/**
 * Decrypt using an explicitly supplied 32-byte key buffer.
 * Used by the key-rotation endpoint so it does not need to swap the env var.
 */
export function decryptSecretWithKey(encryptedValue: string, key: Buffer): string {
  const combined = Buffer.from(encryptedValue, "base64url");
  const iv = combined.subarray(0, IV_LEN);
  const authTag = combined.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = combined.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

/**
 * Parse and validate a 64-character hex key string into a 32-byte Buffer.
 * Returns null if the string is invalid so callers can return a clean error.
 */
export function parseHexKey(hex: unknown): Buffer | null {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** Returns `{ key, value }[]` for all secrets attached to a task. */
export async function getDecryptedTaskSecrets(
  taskId: string,
): Promise<Array<{ key: string; value: string }>> {
  if (!process.env.TASK_SECRET_KEY) return [];
  const rows = await prisma.taskSecret.findMany({
    where: { taskId },
    select: { key: true, encryptedValue: true },
  });
  return rows.map((r) => ({ key: r.key, value: decryptSecret(r.encryptedValue) }));
}
