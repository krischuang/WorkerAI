import { describe, it, expect, beforeEach } from "vitest";
import {
  checkApiLimit,
  recordApiRequest,
  ApiRateLimitStore,
} from "../api-rate-limit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStore(): ApiRateLimitStore {
  return new Map();
}

/** Attempt `n` requests and record each admitted one. */
function burst(
  n: number,
  key: string,
  max: number,
  windowMs: number,
  baseNow: number,
  store: ApiRateLimitStore,
) {
  for (let i = 0; i < n; i++) {
    const now = baseNow + i;
    const r = checkApiLimit(key, max, windowMs, now, store);
    if (!r.limited) recordApiRequest(key, windowMs, now, store);
  }
}

// ─── checkApiLimit — basic admission ─────────────────────────────────────────

describe("checkApiLimit — basic admission", () => {
  it("admits the first request (empty bucket)", () => {
    const r = checkApiLimit("k", 5, 60_000, 1000, makeStore());
    expect(r.limited).toBe(false);
  });

  it("admits requests up to the max", () => {
    const store = makeStore();
    const now = 100_000;
    burst(4, "k", 5, 60_000, now, store);
    expect(checkApiLimit("k", 5, 60_000, now + 4, store).limited).toBe(false);
  });

  it("blocks the request that would exceed max", () => {
    const store = makeStore();
    const now = 100_000;
    burst(5, "k", 5, 60_000, now, store);
    const r = checkApiLimit("k", 5, 60_000, now + 5, store);
    expect(r.limited).toBe(true);
  });

  it("different keys are tracked independently", () => {
    const store = makeStore();
    burst(5, "a", 5, 60_000, 0, store);
    // key "b" has a fresh bucket
    expect(checkApiLimit("b", 5, 60_000, 5, store).limited).toBe(false);
  });
});

// ─── checkApiLimit — sliding window expiry ────────────────────────────────────

describe("checkApiLimit — sliding window expiry", () => {
  it("admits once all prior timestamps have expired", () => {
    const store = makeStore();
    const windowMs = 60_000;
    // 5 requests right at t=0
    burst(5, "k", 5, windowMs, 0, store);
    // At t=60_001 the window has slid past all 5 — should be admitted
    expect(checkApiLimit("k", 5, windowMs, 60_001, store).limited).toBe(false);
  });

  it("still blocks when some timestamps remain inside the window", () => {
    const store = makeStore();
    // 5 requests at t=50_000..50_004
    burst(5, "k", 5, 60_000, 50_000, store);
    // At t=100_000 only t ≤ 40_000 would have expired — t=50_000..50_004 are still inside
    expect(checkApiLimit("k", 5, 60_000, 100_000, store).limited).toBe(true);
  });
});

// ─── checkApiLimit — retryAfterSec ───────────────────────────────────────────

describe("checkApiLimit — retryAfterSec", () => {
  it("returns retryAfterSec ≥ 1", () => {
    const store = makeStore();
    burst(3, "k", 3, 60_000, 0, store);
    const r = checkApiLimit("k", 3, 60_000, 100, store);
    if (!r.limited) throw new Error("expected limited");
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("retryAfterSec approaches 0 near the end of the window", () => {
    const store = makeStore();
    const windowMs = 60_000;
    // Oldest timestamp at t=1000; window ends at t=61_000
    recordApiRequest("k", windowMs, 1000, store);
    recordApiRequest("k", windowMs, 2000, store);
    recordApiRequest("k", windowMs, 3000, store);
    // Check at t=60_500 (500ms before oldest expires)
    const r = checkApiLimit("k", 3, windowMs, 60_500, store);
    if (!r.limited) throw new Error("expected limited");
    expect(r.retryAfterSec).toBeLessThanOrEqual(1);
  });

  it("retryAfterSec is larger when window has plenty of time left", () => {
    const store = makeStore();
    const windowMs = 60_000;
    // Fill bucket right now
    burst(5, "k", 5, windowMs, 1000, store);
    // Check 1 second later — oldest timestamp is t=1000, so retry is ~59s away
    const r = checkApiLimit("k", 5, windowMs, 2000, store);
    if (!r.limited) throw new Error("expected limited");
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(58);
  });
});

// ─── recordApiRequest ─────────────────────────────────────────────────────────

describe("recordApiRequest", () => {
  it("stores the timestamp in the bucket", () => {
    const store = makeStore();
    recordApiRequest("k", 60_000, 5000, store);
    expect(store.get("k")).toContain(5000);
  });

  it("prunes expired timestamps on record", () => {
    const store = makeStore();
    // windowStart at now=120_000 with windowMs=60_000 is t=60_000.
    // Timestamps at t=1,2,3 are all ≤ 60_000, so they are expired.
    store.set("k", [1, 2, 3]);
    recordApiRequest("k", 60_000, 120_000, store);
    expect(store.get("k")).toEqual([120_000]);
  });

  it("accumulates fresh timestamps", () => {
    const store = makeStore();
    recordApiRequest("k", 60_000, 1000, store);
    recordApiRequest("k", 60_000, 2000, store);
    expect(store.get("k")).toEqual([1000, 2000]);
  });
});

// ─── end-to-end: check → record cycle ────────────────────────────────────────

describe("checkApiLimit + recordApiRequest — end-to-end", () => {
  let store: ApiRateLimitStore;
  beforeEach(() => { store = makeStore(); });

  it("admits exactly max requests then blocks", () => {
    const max = 3;
    const windowMs = 60_000;
    const now = 100_000;

    for (let i = 0; i < max; i++) {
      const r = checkApiLimit("k", max, windowMs, now + i, store);
      expect(r.limited).toBe(false);
      recordApiRequest("k", windowMs, now + i, store);
    }

    const blocked = checkApiLimit("k", max, windowMs, now + max, store);
    expect(blocked.limited).toBe(true);
  });

  it("recovers after the window slides past all prior requests", () => {
    const max = 2;
    const windowMs = 10_000;

    recordApiRequest("k", windowMs, 0, store);
    recordApiRequest("k", windowMs, 1, store);

    // Blocked inside window
    expect(checkApiLimit("k", max, windowMs, 5_000, store).limited).toBe(true);

    // Free after window expires
    const r = checkApiLimit("k", max, windowMs, 10_002, store);
    expect(r.limited).toBe(false);
  });

  it("handles concurrent keys without cross-contamination", () => {
    const max = 1;
    const windowMs = 60_000;
    recordApiRequest("x", windowMs, 1000, store);
    // "x" is full
    expect(checkApiLimit("x", max, windowMs, 1001, store).limited).toBe(true);
    // "y" is untouched
    expect(checkApiLimit("y", max, windowMs, 1001, store).limited).toBe(false);
  });
});
