// Exponential backoff tracking for queued-task dispatch attempts.
// Pure functions operating on a caller-supplied Map so the state can live
// on globalThis (survives Next.js HMR) or be injected in tests.

export interface BackoffEntry {
  attempts: number;
  nextAt: number; // ms timestamp — task must not be retried before this
}

const BASE_DELAY_MS = 60_000;  // first retry: 1 min after failure
const MAX_DELAY_MS  = 300_000; // cap: 5 min

export function shouldSkipDueToBackoff(
  taskId: string,
  store: Map<string, BackoffEntry>,
): boolean {
  const entry = store.get(taskId);
  return entry !== undefined && Date.now() < entry.nextAt;
}

export function recordDispatchFailure(
  taskId: string,
  store: Map<string, BackoffEntry>,
): void {
  const prev = store.get(taskId) ?? { attempts: 0, nextAt: 0 };
  const attempts = prev.attempts + 1;
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempts - 1));
  store.set(taskId, { attempts, nextAt: Date.now() + delay });
}

export function clearDispatchBackoff(
  taskId: string,
  store: Map<string, BackoffEntry>,
): void {
  store.delete(taskId);
}

// ─── Agent offline backoff ────────────────────────────────────────────────────
// Prevents the poller from re-pinging agents every 60 s when their tmux session
// has already been confirmed missing. Fixed 5-minute window; cleared on success.

export const AGENT_OFFLINE_BACKOFF_MS = 5 * 60_000; // 5 min

export function shouldSkipAgentOffline(
  agentId: string,
  store: Map<string, number>,
): boolean {
  const expiry = store.get(agentId);
  return expiry !== undefined && Date.now() < expiry;
}

export function recordAgentOffline(
  agentId: string,
  store: Map<string, number>,
  backoffMs = AGENT_OFFLINE_BACKOFF_MS,
): void {
  store.set(agentId, Date.now() + backoffMs);
}

export function clearAgentOffline(
  agentId: string,
  store: Map<string, number>,
): void {
  store.delete(agentId);
}
