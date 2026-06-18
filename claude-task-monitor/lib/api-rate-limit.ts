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

// ─── IP extraction (edge-compatible) ─────────────────────────────────────────

/**
 * Parse TRUSTED_PROXY_IPS into a Set of normalised IP strings.
 * Returns null when the env var is absent or empty (no trusted proxies configured).
 */
function getTrustedProxyIps(): Set<string> | null {
  const raw = process.env.TRUSTED_PROXY_IPS ?? "";
  const ips = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ips.length > 0 ? new Set(ips) : null;
}

/**
 * Extract the best-available client IP from request headers.
 *
 * X-Forwarded-For is only trusted when TRUSTED_PROXY_IPS is configured and the
 * immediate source IP (X-Real-IP) is in that list.  This prevents attackers from
 * spoofing arbitrary IPs and creating unlimited rate-limit buckets.
 *
 * When TRUSTED_PROXY_IPS is not set, X-Forwarded-For is ignored entirely.
 * X-Real-IP is used as-is (typically set by a local reverse proxy like nginx).
 */
export function extractRequestIp(
  request: { headers: { get(key: string): string | null } },
): string {
  const trustedProxies = getTrustedProxyIps();
  const realIp = request.headers.get("x-real-ip");

  if (trustedProxies) {
    // Only honour X-Forwarded-For when the immediate upstream is a trusted proxy.
    if (realIp && trustedProxies.has(realIp)) {
      const forwarded = request.headers.get("x-forwarded-for");
      if (forwarded) return forwarded.split(",")[0].trim();
    }
    // Immediate source is not a trusted proxy — use X-Real-IP or fallback.
    return realIp ?? "127.0.0.1";
  }

  // No trusted proxy list configured — ignore X-Forwarded-For to prevent spoofing.
  return realIp ?? "127.0.0.1";
}

// ─── Admin-login bucket persistence helpers ───────────────────────────────────

/** The rate-limit store key used by the admin-login brute-force guard. */
export const ADMIN_LOGIN_RATE_KEY = "admin-login";

/** Admin-login sliding-window parameters (must match the call in /api/admin/login). */
export const ADMIN_LOGIN_MAX = 10;
export const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Returns the current in-window timestamps for the admin-login bucket.
 * Used to persist the bucket to SystemConfig for crash resilience.
 */
export function getAdminLoginBucket(): number[] {
  const store = getApiRateLimitStore();
  const windowStart = Date.now() - ADMIN_LOGIN_WINDOW_MS;
  return (store.get(ADMIN_LOGIN_RATE_KEY) ?? []).filter((t) => t > windowStart);
}

/**
 * Overwrites the admin-login bucket with the supplied timestamps.
 * Called on startup to restore a previously persisted bucket.
 */
export function setAdminLoginBucket(timestamps: number[]): void {
  const store = getApiRateLimitStore();
  store.set(ADMIN_LOGIN_RATE_KEY, timestamps);
}

/**
 * Injects synthetic timestamps so that any login attempt within the next
 * `lockoutMs` milliseconds will be rate-limited.
 *
 * Works by pre-filling the bucket to ADMIN_LOGIN_MAX with timestamps placed
 * at (now - ADMIN_LOGIN_WINDOW_MS + lockoutMs), which expire exactly
 * `lockoutMs` from now.  Any existing in-window timestamps are preserved.
 */
export function applyAdminLoginRestartLockout(lockoutMs: number): void {
  const now = Date.now();
  const existing = getAdminLoginBucket();
  const needed = Math.max(0, ADMIN_LOGIN_MAX - existing.length);
  if (needed === 0) return; // already at capacity
  const ts = now - ADMIN_LOGIN_WINDOW_MS + lockoutMs;
  const synthetic = Array.from({ length: needed }, () => ts);
  setAdminLoginBucket([...existing, ...synthetic]);
}

// ─── rate_limit_enabled SystemConfig cache ────────────────────────────────────

const RL_ENABLED_KEY = "_rateLimitEnabled";

/**
 * Set the cached rate-limit-enabled flag.
 * Called at startup (instrumentation.node.ts) and on admin config updates.
 * Stored in globalThis so it survives HMR and is shared across all modules
 * in the same Node.js process (middleware + route handlers).
 */
export function setRateLimitEnabled(enabled: boolean): void {
  (globalThis as Record<string, unknown>)[RL_ENABLED_KEY] = enabled;
}

/**
 * Returns true unless the admin has explicitly disabled rate limiting via
 * the SystemConfig key "rate_limit_enabled" = "false".
 * Defaults to true when the flag has not been loaded yet.
 */
export function isRateLimitEnabled(): boolean {
  const g = globalThis as Record<string, unknown>;
  if (RL_ENABLED_KEY in g) return g[RL_ENABLED_KEY] as boolean;
  return true;
}
