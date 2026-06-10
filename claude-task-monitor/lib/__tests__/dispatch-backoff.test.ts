import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  shouldSkipDueToBackoff,
  recordDispatchFailure,
  clearDispatchBackoff,
  shouldSkipAgentOffline,
  recordAgentOffline,
  clearAgentOffline,
  AGENT_OFFLINE_BACKOFF_MS,
  type BackoffEntry,
} from "../dispatch-backoff";

// ─── helpers ────────────────────────────────────────────────────────────────

function freshStore(): Map<string, BackoffEntry> {
  return new Map();
}

// ─── shouldSkipDueToBackoff ──────────────────────────────────────────────────

describe("shouldSkipDueToBackoff", () => {
  it("returns false for an unknown task", () => {
    expect(shouldSkipDueToBackoff("t1", freshStore())).toBe(false);
  });

  it("returns true when nextAt is in the future", () => {
    const store = freshStore();
    store.set("t1", { attempts: 1, nextAt: Date.now() + 60_000 });
    expect(shouldSkipDueToBackoff("t1", store)).toBe(true);
  });

  it("returns false when nextAt has passed", () => {
    const store = freshStore();
    store.set("t1", { attempts: 1, nextAt: Date.now() - 1 });
    expect(shouldSkipDueToBackoff("t1", store)).toBe(false);
  });
});

// ─── recordDispatchFailure ───────────────────────────────────────────────────

describe("recordDispatchFailure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("first failure → 60 s backoff", () => {
    vi.setSystemTime(0);
    const store = freshStore();
    recordDispatchFailure("t1", store);

    const entry = store.get("t1")!;
    expect(entry.attempts).toBe(1);
    expect(entry.nextAt).toBe(60_000);
  });

  it("second failure → 120 s backoff", () => {
    vi.setSystemTime(0);
    const store = freshStore();
    recordDispatchFailure("t1", store);
    recordDispatchFailure("t1", store);

    const entry = store.get("t1")!;
    expect(entry.attempts).toBe(2);
    expect(entry.nextAt).toBe(120_000);
  });

  it("third failure → 240 s backoff", () => {
    vi.setSystemTime(0);
    const store = freshStore();
    recordDispatchFailure("t1", store);
    recordDispatchFailure("t1", store);
    recordDispatchFailure("t1", store);

    const entry = store.get("t1")!;
    expect(entry.attempts).toBe(3);
    expect(entry.nextAt).toBe(240_000);
  });

  it("caps backoff at 300 s regardless of attempt count", () => {
    vi.setSystemTime(0);
    const store = freshStore();
    for (let i = 0; i < 10; i++) recordDispatchFailure("t1", store);

    const entry = store.get("t1")!;
    expect(entry.nextAt).toBe(300_000);
  });

  it("after backoff expires the task is no longer skipped", () => {
    vi.setSystemTime(0);
    const store = freshStore();
    recordDispatchFailure("t1", store);

    // Just before expiry → still skipped
    vi.setSystemTime(59_999);
    expect(shouldSkipDueToBackoff("t1", store)).toBe(true);

    // After expiry → can retry
    vi.setSystemTime(60_001);
    expect(shouldSkipDueToBackoff("t1", store)).toBe(false);
  });
});

// ─── clearDispatchBackoff ────────────────────────────────────────────────────

describe("clearDispatchBackoff", () => {
  it("removes the entry so the task is no longer backed off", () => {
    const store = freshStore();
    store.set("t1", { attempts: 3, nextAt: Date.now() + 300_000 });

    clearDispatchBackoff("t1", store);

    expect(store.has("t1")).toBe(false);
    expect(shouldSkipDueToBackoff("t1", store)).toBe(false);
  });

  it("is a no-op for an unknown task", () => {
    const store = freshStore();
    expect(() => clearDispatchBackoff("unknown", store)).not.toThrow();
  });
});

// ─── Agent offline backoff ───────────────────────────────────────────────────

function freshOfflineStore(): Map<string, number> {
  return new Map();
}

describe("shouldSkipAgentOffline", () => {
  it("returns false for an agent with no offline record", () => {
    expect(shouldSkipAgentOffline("a1", freshOfflineStore())).toBe(false);
  });

  it("returns true when expiry is in the future", () => {
    const store = freshOfflineStore();
    store.set("a1", Date.now() + 60_000);
    expect(shouldSkipAgentOffline("a1", store)).toBe(true);
  });

  it("returns false when expiry has passed", () => {
    const store = freshOfflineStore();
    store.set("a1", Date.now() - 1);
    expect(shouldSkipAgentOffline("a1", store)).toBe(false);
  });
});

describe("recordAgentOffline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("records the default 5-minute expiry", () => {
    vi.setSystemTime(0);
    const store = freshOfflineStore();
    recordAgentOffline("a1", store);

    expect(store.get("a1")).toBe(AGENT_OFFLINE_BACKOFF_MS);
    expect(shouldSkipAgentOffline("a1", store)).toBe(true);
  });

  it("accepts a custom backoff duration", () => {
    vi.setSystemTime(0);
    const store = freshOfflineStore();
    recordAgentOffline("a1", store, 30_000);

    expect(store.get("a1")).toBe(30_000);
  });

  it("overwrites an existing entry on repeated offline events", () => {
    vi.setSystemTime(0);
    const store = freshOfflineStore();
    recordAgentOffline("a1", store, 10_000);

    vi.setSystemTime(5_000);
    recordAgentOffline("a1", store, 10_000); // renews the window

    // Expiry is now 5_000 + 10_000 = 15_000
    expect(store.get("a1")).toBe(15_000);
  });

  it("expires after the window passes", () => {
    vi.setSystemTime(0);
    const store = freshOfflineStore();
    recordAgentOffline("a1", store);

    vi.setSystemTime(AGENT_OFFLINE_BACKOFF_MS + 1);
    expect(shouldSkipAgentOffline("a1", store)).toBe(false);
  });
});

describe("clearAgentOffline", () => {
  it("removes the entry so the agent is no longer skipped", () => {
    const store = freshOfflineStore();
    store.set("a1", Date.now() + 300_000);

    clearAgentOffline("a1", store);

    expect(store.has("a1")).toBe(false);
    expect(shouldSkipAgentOffline("a1", store)).toBe(false);
  });

  it("is a no-op for an unknown agent", () => {
    const store = freshOfflineStore();
    expect(() => clearAgentOffline("unknown", store)).not.toThrow();
  });
});
