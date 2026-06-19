/**
 * Admin session nonce — rotated on logout to invalidate all existing sessions.
 *
 * The nonce is stored in SystemConfig under the key "admin_session_nonce".
 * It is cached in globalThis with a short TTL so the middleware does not hit
 * the database on every admin request.
 *
 * When no nonce exists in the DB (fresh install, pre-migration) a default of
 * "" is used, which preserves backward compatibility with existing sessions
 * until they are explicitly rotated by logging out.
 */

import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";

export const NONCE_CONFIG_KEY = "admin_session_nonce";
const CACHE_KEY = "_adminSessionNonce";
const CACHE_TTL_MS = 30_000;

interface NonceCache {
  value: string;
  expiresAt: number;
}

function getGlobal(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

/** Return the cached nonce without a DB round-trip if the cache is fresh. */
function getCached(): string | null {
  const g = getGlobal();
  const entry = g[CACHE_KEY] as NonceCache | undefined;
  if (entry && Date.now() < entry.expiresAt) return entry.value;
  return null;
}

function setCached(value: string): void {
  (getGlobal())[CACHE_KEY] = { value, expiresAt: Date.now() + CACHE_TTL_MS };
}

/** Invalidate the in-process cache (called on logout / nonce rotation). */
export function clearNonceCache(): void {
  delete (getGlobal())[CACHE_KEY];
}

/**
 * Fetch the current nonce, using the in-process cache when possible.
 * Falls back to "" (no nonce) when the DB has no entry yet.
 */
export async function getCurrentNonce(): Promise<string> {
  const cached = getCached();
  if (cached !== null) return cached;

  const row = await prisma.systemConfig.findUnique({
    where: { key: NONCE_CONFIG_KEY },
    select: { value: true },
  });
  const nonce = row?.value ?? "";
  setCached(nonce);
  return nonce;
}

/**
 * Generate a fresh nonce, persist it to the DB, and clear the cache so the
 * next request re-reads the new value.
 *
 * Called on logout to invalidate all existing admin session cookies.
 */
export async function rotateNonce(): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  await prisma.systemConfig.upsert({
    where: { key: NONCE_CONFIG_KEY },
    create: { key: NONCE_CONFIG_KEY, value: nonce },
    update: { value: nonce },
  });
  clearNonceCache();
  return nonce;
}
