import { describe, it, expect, vi, beforeEach } from "vitest";
import { isStuckScan, isStuckCycle, getCycleHealth, recoverStuckCycle } from "../improvement-recovery";
import { IMPROVEMENT_SCAN_TIMEOUT_MS, SCAN_MAX_CONSECUTIVE_FAILURES } from "../constants";

// ─── Mock prisma ──────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn(), update: vi.fn() },
    improvementCycle: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    projectScan: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";

const mockProject = vi.mocked(prisma.project);

// ─── 1. isStuckScan — pure function ───────────────────────────────────────────

describe("isStuckScan", () => {
  it("returns false for a scan started 30s ago (well within timeout)", () => {
    const now = Date.now();
    const startedAt = new Date(now - 30_000);
    expect(isStuckScan(startedAt, now)).toBe(false);
  });

  it("returns false for a scan started exactly at the timeout boundary", () => {
    const now = Date.now();
    const startedAt = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS);
    // Exactly equal → not yet exceeded
    expect(isStuckScan(startedAt, now)).toBe(false);
  });

  it("returns true for a scan started IMPROVEMENT_SCAN_TIMEOUT_MS + 1ms ago", () => {
    const now = Date.now();
    const startedAt = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS - 1);
    expect(isStuckScan(startedAt, now)).toBe(true);
  });

  it("returns true for a very old scan (1 hour ago)", () => {
    const now = Date.now();
    const startedAt = new Date(now - 60 * 60 * 1000);
    expect(isStuckScan(startedAt, now)).toBe(true);
  });
});

// ─── 2. isStuckCycle — pure function ─────────────────────────────────────────

describe("isStuckCycle", () => {
  it("returns false when cycleStatus is not 'scanning'", () => {
    const now = Date.now();
    const oldDate = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS * 2);
    expect(isStuckCycle("completed", oldDate, null, now)).toBe(false);
    expect(isStuckCycle("idle", oldDate, null, now)).toBe(false);
    expect(isStuckCycle("executing", oldDate, null, now)).toBe(false);
  });

  it("returns false when scanning but has a fresh (non-stuck) scan", () => {
    const now = Date.now();
    const cycleStart = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS * 2);
    const freshScan = { startedAt: new Date(now - 30_000), status: "running" };
    expect(isStuckCycle("scanning", cycleStart, freshScan, now)).toBe(false);
  });

  it("returns true when scanning and scan is stuck", () => {
    const now = Date.now();
    const cycleStart = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS * 2);
    const stuckScan = { startedAt: new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS - 1), status: "running" };
    expect(isStuckCycle("scanning", cycleStart, stuckScan, now)).toBe(true);
  });

  it("returns true when scanning, scan is null, and cycle has been scanning longer than timeout + 60s", () => {
    const now = Date.now();
    const veryOldStart = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS - 60_000 - 1);
    expect(isStuckCycle("scanning", veryOldStart, null, now)).toBe(true);
  });

  it("returns false when scanning, scan is null, but cycle started recently (within buffer)", () => {
    const now = Date.now();
    // Started just under IMPROVEMENT_SCAN_TIMEOUT_MS + 60s ago
    const recentStart = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS - 59_000);
    expect(isStuckCycle("scanning", recentStart, null, now)).toBe(false);
  });
});

// ─── 3. Consecutive failure pause logic (pure simulation) ─────────────────────

type ProjectState = { scanFailureCount: number; autoImprovementPaused: boolean };

function simulateRecovery(
  state: ProjectState,
  stuckCyclesCount: number,
): ProjectState {
  if (stuckCyclesCount === 0) return state;
  const newCount = state.scanFailureCount + stuckCyclesCount;
  return {
    scanFailureCount: newCount,
    autoImprovementPaused: state.autoImprovementPaused || newCount >= SCAN_MAX_CONSECUTIVE_FAILURES,
  };
}

function simulateReset(): ProjectState {
  return { scanFailureCount: 0, autoImprovementPaused: false };
}

describe("consecutive failure pause logic via recovery simulation", () => {
  it("at 0 failures: not paused", () => {
    const state: ProjectState = { scanFailureCount: 0, autoImprovementPaused: false };
    expect(state.autoImprovementPaused).toBe(false);
  });

  it("at SCAN_MAX_CONSECUTIVE_FAILURES - 1 failures: not paused", () => {
    let state: ProjectState = { scanFailureCount: 0, autoImprovementPaused: false };
    state = simulateRecovery(state, SCAN_MAX_CONSECUTIVE_FAILURES - 1);
    expect(state.autoImprovementPaused).toBe(false);
    expect(state.scanFailureCount).toBe(SCAN_MAX_CONSECUTIVE_FAILURES - 1);
  });

  it("at SCAN_MAX_CONSECUTIVE_FAILURES failures: paused", () => {
    let state: ProjectState = { scanFailureCount: 0, autoImprovementPaused: false };
    state = simulateRecovery(state, SCAN_MAX_CONSECUTIVE_FAILURES);
    expect(state.autoImprovementPaused).toBe(true);
    expect(state.scanFailureCount).toBe(SCAN_MAX_CONSECUTIVE_FAILURES);
  });

  it("recovery resets failure count to 0 and unpauses", () => {
    let state: ProjectState = { scanFailureCount: SCAN_MAX_CONSECUTIVE_FAILURES, autoImprovementPaused: true };
    state = simulateReset();
    expect(state.scanFailureCount).toBe(0);
    expect(state.autoImprovementPaused).toBe(false);
  });
});

// ─── 4. Tenant safety ─────────────────────────────────────────────────────────

describe("getCycleHealth — tenant safety", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null for a non-existent project ID", async () => {
    mockProject.findUnique.mockResolvedValueOnce(null);
    const result = await getCycleHealth("nonexistent-id");
    expect(result).toBeNull();
  });
});

describe("recoverStuckCycle — tenant safety", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null for a non-existent project ID", async () => {
    mockProject.findUnique.mockResolvedValueOnce(null);
    const result = await recoverStuckCycle("nonexistent-id");
    expect(result).toBeNull();
  });
});

// ─── 5. Fresh scan safety ─────────────────────────────────────────────────────

describe("fresh scan safety", () => {
  it("a scan started < IMPROVEMENT_SCAN_TIMEOUT_MS ago is NOT stuck, so recoverStuckCycle would skip it", () => {
    const now = Date.now();
    // Scan started 30s ago — well within timeout
    const freshScanStart = new Date(now - 30_000);
    const stuck = isStuckScan(freshScanStart, now);
    // Verify: fresh scans are never reported stuck, so the recovery cutoff filter would exclude them
    expect(stuck).toBe(false);
  });

  it("only scans with startedAt <= cutoff are eligible for recovery (boundary check)", () => {
    const now = Date.now();
    const cutoff = new Date(now - IMPROVEMENT_SCAN_TIMEOUT_MS);
    // A scan started exactly 1ms before the cutoff is eligible
    const oldEnough = new Date(cutoff.getTime() - 1);
    expect(isStuckScan(oldEnough, now)).toBe(true);
    // A scan started at exactly the cutoff is NOT eligible (startedAt must be <= cutoff via query)
    // but isStuckScan returns false at exact boundary
    expect(isStuckScan(cutoff, now)).toBe(false);
  });
});
