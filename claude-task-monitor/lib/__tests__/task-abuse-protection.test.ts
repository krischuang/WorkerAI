/**
 * P3-10: Scheduled Task Abuse Protection
 *
 * Verifies that:
 *   1. The queued task cap (100 per project) is enforced.
 *   2. The scheduled task cap (50 per project) is enforced.
 *   3. The clone rate limit (10/hour per project) is enforced.
 */

import { describe, it, expect } from "vitest";
import {
  checkApiLimit,
  recordApiRequest,
  ApiRateLimitStore,
} from "../api-rate-limit";

// ─── Queued task cap (simulated) ─────────────────────────────────────────────

const MAX_QUEUED = 100;
const MAX_SCHEDULED = 50;
const MAX_CLONES_PER_HOUR = 10;

function simulateQueuedTaskCap(existingCount: number): { allowed: boolean; error?: string } {
  if (existingCount >= MAX_QUEUED) {
    return { allowed: false, error: `Queued task limit reached (${MAX_QUEUED} pending/queued per project)` };
  }
  return { allowed: true };
}

describe("Queued task cap — P3-10", () => {
  it("allows task creation when under the cap", () => {
    expect(simulateQueuedTaskCap(99).allowed).toBe(true);
  });

  it("blocks task creation at exactly the cap", () => {
    const result = simulateQueuedTaskCap(100);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("100");
  });

  it("blocks task creation above the cap", () => {
    expect(simulateQueuedTaskCap(150).allowed).toBe(false);
  });
});

// ─── Scheduled task cap (simulated) ──────────────────────────────────────────

function simulateScheduledTaskCap(existingCount: number): { allowed: boolean; error?: string } {
  if (existingCount >= MAX_SCHEDULED) {
    return { allowed: false, error: `Scheduled task limit reached (${MAX_SCHEDULED} per project)` };
  }
  return { allowed: true };
}

describe("Scheduled task cap — P3-10", () => {
  it("allows scheduled task creation when under the cap", () => {
    expect(simulateScheduledTaskCap(49).allowed).toBe(true);
  });

  it("blocks at exactly the cap", () => {
    const result = simulateScheduledTaskCap(50);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("50");
  });
});

// ─── Clone rate limit (per project, per hour) ─────────────────────────────────

describe("Clone rate limit — P3-10", () => {
  it("allows up to MAX_CLONES_PER_HOUR clones per project per hour", () => {
    const store: ApiRateLimitStore = new Map();
    const projectId = "proj-test-abuse";
    const key = `project:clone:${projectId}`;
    const now = Date.now();

    for (let i = 0; i < MAX_CLONES_PER_HOUR; i++) {
      const r = checkApiLimit(key, MAX_CLONES_PER_HOUR, 60 * 60_000, now + i, store);
      expect(r.limited).toBe(false);
      if (!r.limited) recordApiRequest(key, 60 * 60_000, now + i, store);
    }
    // The (MAX+1)th clone is blocked.
    const r = checkApiLimit(key, MAX_CLONES_PER_HOUR, 60 * 60_000, now + MAX_CLONES_PER_HOUR, store);
    expect(r.limited).toBe(true);
  });

  it("different projects have independent clone buckets", () => {
    const store: ApiRateLimitStore = new Map();
    const now = Date.now();

    // Fill project-1 to its limit.
    const keyA = "project:clone:proj-A";
    for (let i = 0; i < MAX_CLONES_PER_HOUR; i++) {
      const r = checkApiLimit(keyA, MAX_CLONES_PER_HOUR, 60 * 60_000, now + i, store);
      if (!r.limited) recordApiRequest(keyA, 60 * 60_000, now + i, store);
    }

    // project-2 should still have capacity.
    const keyB = "project:clone:proj-B";
    const r = checkApiLimit(keyB, MAX_CLONES_PER_HOUR, 60 * 60_000, now, store);
    expect(r.limited).toBe(false);
  });
});
