/**
 * Connection limiting for the WebSocket SSH terminal server.
 *
 * Three independent gates — all must pass before a connection is admitted:
 *   1. Global cap   — total live connections across all IPs
 *   2. Per-IP cap   — concurrent connections from one address
 *   3. Per-IP rate  — new connections opened in the last RATE_WINDOW_MS
 *
 * Defaults are tunable via env vars (read once at import time):
 *   WS_MAX_CONNECTIONS        (default 50)
 *   WS_MAX_CONNECTIONS_PER_IP (default 10)
 *   WS_RATE_LIMIT             (default 20 per minute)
 */

export const MAX_TOTAL_CONNECTIONS  = Number(process.env.WS_MAX_CONNECTIONS        ?? 50);
export const MAX_CONNECTIONS_PER_IP = Number(process.env.WS_MAX_CONNECTIONS_PER_IP ?? 10);
export const RATE_WINDOW_MS         = 60_000;
export const RATE_LIMIT_MAX         = Number(process.env.WS_RATE_LIMIT             ?? 20);

export type RateLimitStore = {
  activeByIp:     Map<string, number>;
  timestampsByIp: Map<string, number[]>;
  total:          { value: number };
};

export function makeStore(): RateLimitStore {
  return {
    activeByIp:     new Map(),
    timestampsByIp: new Map(),
    total:          { value: 0 },
  };
}

export type AdmitResult =
  | { admitted: true }
  | { admitted: false; reason: "total_cap" | "ip_cap" | "rate_limit" };

/** Decide whether to admit a new connection. Pure — no side effects. */
export function checkLimits(
  ip: string,
  now: number,
  store: RateLimitStore,
  opts: {
    maxTotal:    number;
    maxPerIp:    number;
    rateMax:     number;
    rateWindowMs: number;
  }
): AdmitResult {
  if (store.total.value >= opts.maxTotal) {
    return { admitted: false, reason: "total_cap" };
  }

  if ((store.activeByIp.get(ip) ?? 0) >= opts.maxPerIp) {
    return { admitted: false, reason: "ip_cap" };
  }

  const windowStart = now - opts.rateWindowMs;
  const recent = (store.timestampsByIp.get(ip) ?? []).filter(t => t > windowStart);
  if (recent.length >= opts.rateMax) {
    return { admitted: false, reason: "rate_limit" };
  }

  return { admitted: true };
}

/** Record a new admitted connection. Must be called after checkLimits returns admitted:true. */
export function recordAdmit(ip: string, now: number, store: RateLimitStore, rateWindowMs: number) {
  store.total.value += 1;
  store.activeByIp.set(ip, (store.activeByIp.get(ip) ?? 0) + 1);

  const windowStart = now - rateWindowMs;
  const ts = (store.timestampsByIp.get(ip) ?? []).filter(t => t > windowStart);
  ts.push(now);
  store.timestampsByIp.set(ip, ts);
}

/** Release one connection slot for the given IP. */
export function recordRelease(ip: string, store: RateLimitStore) {
  store.total.value = Math.max(0, store.total.value - 1);
  const n = store.activeByIp.get(ip) ?? 1;
  if (n <= 1) store.activeByIp.delete(ip);
  else        store.activeByIp.set(ip, n - 1);
}
