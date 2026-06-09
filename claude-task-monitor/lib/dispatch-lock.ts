// Per-server dispatch mutex. All three dispatch paths (60s poller, Run button,
// PUT auto-run) share this in-process lock so at most one sendTaskToTmux call
// can be outstanding for a given server at any time.
//
// Uses globalThis so the map survives module re-evaluation under Next.js's
// hot-module infrastructure (same pattern as _usagePollerStarted).

const g = globalThis as { _serverDispatchLocks?: Map<string, Promise<void>> };
if (!g._serverDispatchLocks) g._serverDispatchLocks = new Map();

export function withServerDispatchLock<T>(
  serverId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = g._serverDispatchLocks!;
  const queue = locks.get(serverId) ?? Promise.resolve();
  const result = queue.then(() => fn());
  // Silence the chained promise so unhandled-rejection monitors stay quiet;
  // the caller holds a reference to `result` and observes any error.
  locks.set(serverId, result.then(() => {}, () => {}));
  return result;
}
