/**
 * In-process cache for the admin session nonce.
 *
 * The nonce is loaded from the DB at startup (instrumentation.node.ts) and
 * updated immediately when the admin logs out (nonce rotation).  The
 * middleware reads from this cache so it never needs a DB round-trip.
 *
 * This module MUST NOT import prisma or any Node.js-only built-in so it
 * remains importable from middleware.ts (which runs before Node.js context
 * is fully established in some Next.js edge-runtime scenarios).
 */

const NONCE_GLOBAL_KEY = "_adminSessionNonce";

function g(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

/** Return the in-process nonce, or "" when not yet loaded. */
export function getAdminNonce(): string {
  return (g()[NONCE_GLOBAL_KEY] as string | undefined) ?? "";
}

/** Overwrite the in-process nonce (called at startup and on rotation). */
export function setAdminNonce(nonce: string): void {
  g()[NONCE_GLOBAL_KEY] = nonce;
}
