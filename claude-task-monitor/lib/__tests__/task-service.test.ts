import { describe, test, expect } from "vitest";
import { buildUsageBlockInfo } from "../task-service";
import { USAGE_THRESHOLD } from "../constants";

const SESSION_RESET = new Date("2026-06-15T10:00:00Z");
const WEEK_RESET    = new Date("2026-06-20T10:00:00Z");

const fullResource = {
  claudeSessionResets: "Jun 15, 10:00 am",
  claudeWeekResets:    "Jun 20, 10:00 am",
  claudeSessionResetsAt: SESSION_RESET,
  claudeWeekResetsAt:    WEEK_RESET,
};

describe("buildUsageBlockInfo", () => {
  test("sessionBlocked true when sessionPct >= USAGE_THRESHOLD", () => {
    const info = buildUsageBlockInfo(USAGE_THRESHOLD, 0, fullResource);
    expect(info.sessionBlocked).toBe(true);
    expect(info.weekBlocked).toBe(false);
  });

  test("weekBlocked true when weekPct >= USAGE_THRESHOLD", () => {
    const info = buildUsageBlockInfo(0, USAGE_THRESHOLD, fullResource);
    expect(info.sessionBlocked).toBe(false);
    expect(info.weekBlocked).toBe(true);
  });

  test("neither blocked when both pcts below threshold", () => {
    const info = buildUsageBlockInfo(89, 89, fullResource);
    expect(info.sessionBlocked).toBe(false);
    expect(info.weekBlocked).toBe(false);
  });

  test("nearestResetsAt is session reset when only session is blocked", () => {
    const info = buildUsageBlockInfo(USAGE_THRESHOLD, 0, fullResource);
    expect(info.nearestResetsAt).toBe(SESSION_RESET.toISOString());
  });

  test("nearestResetsAt is week reset when only week is blocked", () => {
    const info = buildUsageBlockInfo(0, USAGE_THRESHOLD, fullResource);
    expect(info.nearestResetsAt).toBe(WEEK_RESET.toISOString());
  });

  test("nearestResetsAt picks the earlier reset when both are blocked", () => {
    const info = buildUsageBlockInfo(USAGE_THRESHOLD, USAGE_THRESHOLD, fullResource);
    // SESSION_RESET (Jun 15) is earlier than WEEK_RESET (Jun 20)
    expect(info.nearestResetsAt).toBe(SESSION_RESET.toISOString());
  });

  test("nearestResetsAt is null when blocked but no reset date is set", () => {
    const info = buildUsageBlockInfo(USAGE_THRESHOLD, 0, {
      ...fullResource,
      claudeSessionResetsAt: null,
    });
    expect(info.nearestResetsAt).toBeNull();
  });

  test("nearestResetsAt is null when no limit is hit (nothing to wait for)", () => {
    const info = buildUsageBlockInfo(50, 60, fullResource);
    expect(info.nearestResetsAt).toBeNull();
  });

  test("passes through human-readable reset strings unchanged", () => {
    const info = buildUsageBlockInfo(50, 60, fullResource);
    expect(info.sessionResets).toBe("Jun 15, 10:00 am");
    expect(info.weekResets).toBe("Jun 20, 10:00 am");
  });

  test("sessionResetsAt and weekResetsAt are ISO strings", () => {
    const info = buildUsageBlockInfo(50, 60, fullResource);
    expect(info.sessionResetsAt).toBe(SESSION_RESET.toISOString());
    expect(info.weekResetsAt).toBe(WEEK_RESET.toISOString());
  });

  test("null reset dates become null in output", () => {
    const info = buildUsageBlockInfo(50, 60, {
      claudeSessionResets:   null,
      claudeWeekResets:      null,
      claudeSessionResetsAt: null,
      claudeWeekResetsAt:    null,
    });
    expect(info.sessionResetsAt).toBeNull();
    expect(info.weekResetsAt).toBeNull();
    expect(info.nearestResetsAt).toBeNull();
  });

  test("exposes raw sessionPct and weekPct values", () => {
    const info = buildUsageBlockInfo(72.5, 88.3, fullResource);
    expect(info.sessionPct).toBe(72.5);
    expect(info.weekPct).toBe(88.3);
  });
});
