/**
 * Sliding-window rate limiter for Next.js App Router route handlers.
 *
 * Design notes
 * ────────────
 * • Pure core functions (checkApiLimit / recordApiRequest) take an explicit
 *   store argument so they are unit-testable without side effects.
 * • The global store is held on globalThis under a stable key so it survives
 *   Next.js / Turbopack HMR module re-evaluation (same pattern as dispatch-lock).
 * • Keys are caller-supplied strings — typically namespaced by endpoint and
 *   resource ID, e.g. "server:claude-usage:<serverId>".
 * • Single-user app: no per-IP tracking needed; all requests are from the
 *   same browser session.  Per-resource keys naturally scope each limit.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Sliding-window bucket: sorted array of admission timestamps (ms epoch). */
export type ApiRateBucket = number[];

/** Store maps a rate-limit key → its bucket. */
export type ApiRateLimitStore = Map<string, ApiRateBucket>;

export type ApiRateLimitResult =
  | { limited: false }
  | { limited: true; retryAfterSec: number };

// ─── Store access ─────────────────────────────────────────────────────────────

const STORE_KEY = "_apiRateLimitStore";

/** Returns the HMR-safe global store (created on first call). */
export function getApiRateLimitStore(): ApiRateLimitStore {
  const g = globalThis as Record<string, unknown>;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = new Map<string, ApiRateBucket>();
  }
  return g[STORE_KEY] as ApiRateLimitStore;
}

// ─── Pure core ────────────────────────────────────────────────────────────────

/**
 * Decide whether a new request should be admitted.  Pure — no side effects.
 *
 * @param key       Namespaced rate-limit key
 * @param max       Maximum requests allowed inside the window
 * @param windowMs  Sliding window duration in milliseconds
 * @param now       Current epoch ms (injectable for tests)
 * @param store     Rate-limit store
 */
export function checkApiLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number,
  store: ApiRateLimitStore,
): ApiRateLimitResult {
  const windowStart = now - windowMs;
  const recent = (store.get(key) ?? []).filter((t) => t > windowStart);

  if (recent.length >= max) {
    // Next slot opens when the oldest in-window timestamp falls out.
    const oldest = Math.min(...recent);
    const retryAfterSec = Math.ceil((oldest + windowMs - now) / 1000);
    return { limited: true, retryAfterSec: Math.max(1, retryAfterSec) };
  }

  return { limited: false };
}

/**
 * Record an admitted request.  Must be called after checkApiLimit returns
 * `{ limited: false }` and before responding to the client.
 */
export function recordApiRequest(
  key: string,
  windowMs: number,
  now: number,
  store: ApiRateLimitStore,
): void {
  const windowStart = now - windowMs;
  const recent = (store.get(key) ?? []).filter((t) => t > windowStart);
  recent.push(now);
  store.set(key, recent);
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────

/**
 * Check and record in one call using the global store.
 * Returns the result; callers respond with 429 when `limited === true`.
 *
 * Usage in a route handler:
 *   const rl = apiRateLimit(`server:claude-usage:${id}`, 6, 60_000);
 *   if (rl.limited) return rateLimitResponse(rl.retryAfterSec);
 */
export function apiRateLimit(
  key: string,
  max: number,
  windowMs: number,
): ApiRateLimitResult {
  const store = getApiRateLimitStore();
  const now = Date.now();
  const result = checkApiLimit(key, max, windowMs, now, store);
  if (!result.limited) {
    recordApiRequest(key, windowMs, now, store);
  }
  return result;
}

// ─── Response helper ──────────────────────────────────────────────────────────

/** Build a standard 429 response with a Retry-After header. */
export function rateLimitResponse(retryAfterSec: number): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests", retryAfter: retryAfterSec }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    },
  );
}
