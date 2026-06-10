import { describe, it, expect, beforeEach } from "vitest";
import {
  makeStore,
  checkLimits,
  recordAdmit,
  recordRelease,
  validateWsConnectParams,
  type RateLimitStore,
} from "../ws-rate-limit";

const OPTS = {
  maxTotal:    50,
  maxPerIp:    10,
  rateMax:     20,
  rateWindowMs: 60_000,
};

function admit(ip: string, now: number, store: RateLimitStore) {
  const r = checkLimits(ip, now, store, OPTS);
  if (r.admitted) recordAdmit(ip, now, store, OPTS.rateWindowMs);
  return r;
}

// ─── checkLimits — global cap ────────────────────────────────────────────────

describe("checkLimits — global cap", () => {
  it("admits when total is below the cap", () => {
    const store = makeStore();
    expect(checkLimits("1.1.1.1", 0, store, { ...OPTS, maxTotal: 2 }).admitted).toBe(true);
  });

  it("rejects with total_cap when global limit is reached", () => {
    const store = makeStore();
    store.total.value = 2;
    const r = checkLimits("1.1.1.1", 0, store, { ...OPTS, maxTotal: 2 });
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toBe("total_cap");
  });
});

// ─── checkLimits — per-IP concurrent cap ─────────────────────────────────────

describe("checkLimits — per-IP concurrent cap", () => {
  it("admits a fresh IP", () => {
    const store = makeStore();
    expect(checkLimits("2.2.2.2", 0, store, { ...OPTS, maxPerIp: 3 }).admitted).toBe(true);
  });

  it("rejects with ip_cap when per-IP limit is reached", () => {
    const store = makeStore();
    store.activeByIp.set("2.2.2.2", 3);
    const r = checkLimits("2.2.2.2", 0, store, { ...OPTS, maxPerIp: 3 });
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toBe("ip_cap");
  });

  it("does not affect a different IP", () => {
    const store = makeStore();
    store.activeByIp.set("2.2.2.2", 3);
    expect(checkLimits("3.3.3.3", 0, store, { ...OPTS, maxPerIp: 3 }).admitted).toBe(true);
  });
});

// ─── checkLimits — per-IP rate limit ─────────────────────────────────────────

describe("checkLimits — per-IP rate limit", () => {
  it("admits within the rate window", () => {
    const store = makeStore();
    store.timestampsByIp.set("4.4.4.4", [0, 1000, 2000]); // 3 recent
    expect(checkLimits("4.4.4.4", 5000, store, { ...OPTS, rateMax: 5, rateWindowMs: 60_000 }).admitted).toBe(true);
  });

  it("rejects with rate_limit when window is full", () => {
    const now = 60_000;
    const store = makeStore();
    // 5 timestamps all within the window
    store.timestampsByIp.set("4.4.4.4", [1000, 10000, 20000, 40000, 59000]);
    const r = checkLimits("4.4.4.4", now, store, { ...OPTS, rateMax: 5, rateWindowMs: 60_000 });
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toBe("rate_limit");
  });

  it("admits after old timestamps expire outside the window", () => {
    const store = makeStore();
    // 5 timestamps all older than the window start
    store.timestampsByIp.set("4.4.4.4", [1, 2, 3, 4, 5]);
    // now = 120_000 → windowStart = 60_000 → all 5 are outside the window
    const r = checkLimits("4.4.4.4", 120_000, store, { ...OPTS, rateMax: 5, rateWindowMs: 60_000 });
    expect(r.admitted).toBe(true);
  });
});

// ─── recordAdmit ─────────────────────────────────────────────────────────────

describe("recordAdmit", () => {
  it("increments total and per-IP active count", () => {
    const store = makeStore();
    recordAdmit("5.5.5.5", 0, store, 60_000);
    expect(store.total.value).toBe(1);
    expect(store.activeByIp.get("5.5.5.5")).toBe(1);
  });

  it("appends timestamp and prunes expired ones", () => {
    const store = makeStore();
    // Pre-seed an old timestamp that should be pruned
    store.timestampsByIp.set("5.5.5.5", [1]);
    // now = 120_000, windowStart = 60_000 → timestamp 1 is outside window
    recordAdmit("5.5.5.5", 120_000, store, 60_000);
    expect(store.timestampsByIp.get("5.5.5.5")).toEqual([120_000]);
  });

  it("accumulates multiple admits for the same IP", () => {
    const store = makeStore();
    recordAdmit("6.6.6.6", 0, store, 60_000);
    recordAdmit("6.6.6.6", 1, store, 60_000);
    expect(store.activeByIp.get("6.6.6.6")).toBe(2);
    expect(store.total.value).toBe(2);
  });
});

// ─── recordRelease ────────────────────────────────────────────────────────────

describe("recordRelease", () => {
  it("decrements total and per-IP active count", () => {
    const store = makeStore();
    store.total.value = 3;
    store.activeByIp.set("7.7.7.7", 2);
    recordRelease("7.7.7.7", store);
    expect(store.total.value).toBe(2);
    expect(store.activeByIp.get("7.7.7.7")).toBe(1);
  });

  it("removes the IP entry when the last connection closes", () => {
    const store = makeStore();
    store.total.value = 1;
    store.activeByIp.set("7.7.7.7", 1);
    recordRelease("7.7.7.7", store);
    expect(store.total.value).toBe(0);
    expect(store.activeByIp.has("7.7.7.7")).toBe(false);
  });

  it("does not go below zero for total", () => {
    const store = makeStore();
    store.total.value = 0;
    store.activeByIp.set("7.7.7.7", 1);
    recordRelease("7.7.7.7", store);
    expect(store.total.value).toBe(0);
  });
});

// ─── end-to-end: admit → release cycle ───────────────────────────────────────

describe("admit → release lifecycle", () => {
  let store: RateLimitStore;
  beforeEach(() => { store = makeStore(); });

  it("admits up to the per-IP cap, then rejects, then admits again after release", () => {
    const opts3 = { ...OPTS, maxPerIp: 3 };

    for (let i = 0; i < 3; i++) {
      const r = checkLimits("8.8.8.8", i, store, opts3);
      expect(r.admitted).toBe(true);
      recordAdmit("8.8.8.8", i, store, opts3.rateWindowMs);
    }

    // 4th connection should be rejected
    expect(checkLimits("8.8.8.8", 3, store, opts3).admitted).toBe(false);

    // Release one and try again
    recordRelease("8.8.8.8", store);
    expect(checkLimits("8.8.8.8", 4, store, opts3).admitted).toBe(true);
  });

  it("tracks different IPs independently", () => {
    const opts1 = { ...OPTS, maxPerIp: 1 };

    admit("10.0.0.1", 0, store);
    admit("10.0.0.2", 0, store);

    // Both IPs at their individual limit
    expect(checkLimits("10.0.0.1", 1, store, opts1).admitted).toBe(false);
    expect(checkLimits("10.0.0.2", 1, store, opts1).admitted).toBe(false);
    // A third IP is unaffected
    expect(checkLimits("10.0.0.3", 1, store, opts1).admitted).toBe(true);
  });

  it("rate window allows a burst then blocks further connections", () => {
    const opts = { ...OPTS, rateMax: 3, rateWindowMs: 60_000 };
    const now = 100_000;

    for (let i = 0; i < 3; i++) {
      const r = checkLimits("9.9.9.9", now + i, store, opts);
      expect(r.admitted).toBe(true);
      recordAdmit("9.9.9.9", now + i, store, opts.rateWindowMs);
    }

    // 4th within the same window — rate blocked
    const r = checkLimits("9.9.9.9", now + 3, store, opts);
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toBe("rate_limit");

    // After the window expires all prior timestamps are gone
    const later = now + 3 + 60_001;
    expect(checkLimits("9.9.9.9", later, store, opts).admitted).toBe(true);
  });
});

// ─── validateWsConnectParams (WebSocket connect — missing serverId) ───────────

describe("validateWsConnectParams — missing serverId / agentId", () => {
  it("returns an error when both serverId and agentId are null", () => {
    const err = validateWsConnectParams(null, null);
    expect(err).not.toBeNull();
    expect(err!).toMatch(/serverId or agentId is required/i);
  });

  it("returns an error when both are empty strings", () => {
    const err = validateWsConnectParams("", "");
    expect(err).not.toBeNull();
  });

  it("returns null when serverId is provided and agentId is null", () => {
    expect(validateWsConnectParams("server-abc", null)).toBeNull();
  });

  it("returns null when agentId is provided and serverId is null", () => {
    expect(validateWsConnectParams(null, "agent-xyz")).toBeNull();
  });

  it("returns null when both are provided", () => {
    expect(validateWsConnectParams("server-abc", "agent-xyz")).toBeNull();
  });

  it("returns an error when serverId is empty and agentId is null", () => {
    expect(validateWsConnectParams("", null)).not.toBeNull();
  });

  it("returns an error when agentId is empty and serverId is null", () => {
    expect(validateWsConnectParams(null, "")).not.toBeNull();
  });
});
