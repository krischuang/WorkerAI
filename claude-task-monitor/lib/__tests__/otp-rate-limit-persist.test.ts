/**
 * P3-3: Persist OTP Rate Limits
 *
 * Verifies that:
 *   1. The admin-otp bucket correctly records attempt timestamps.
 *   2. getAdminOtpBucket() returns in-window timestamps.
 *   3. setAdminOtpBucket() restores timestamps (restart simulation).
 *   4. Restored bucket still blocks when the limit is reached.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkApiLimit,
  recordApiRequest,
  getAdminOtpBucket,
  setAdminOtpBucket,
  ADMIN_OTP_MAX,
  ADMIN_OTP_WINDOW_MS,
  getApiRateLimitStore,
  ADMIN_OTP_RATE_KEY,
} from "../api-rate-limit";

function freshStore() {
  return new Map<string, number[]>();
}

describe("admin-otp bucket — basic rate limiting", () => {
  it("admits up to ADMIN_OTP_MAX attempts", () => {
    const store = freshStore();
    const now = Date.now();
    for (let i = 0; i < ADMIN_OTP_MAX; i++) {
      const r = checkApiLimit(ADMIN_OTP_RATE_KEY, ADMIN_OTP_MAX, ADMIN_OTP_WINDOW_MS, now + i, store);
      expect(r.limited).toBe(false);
      if (!r.limited) recordApiRequest(ADMIN_OTP_RATE_KEY, ADMIN_OTP_WINDOW_MS, now + i, store);
    }
    const r = checkApiLimit(ADMIN_OTP_RATE_KEY, ADMIN_OTP_MAX, ADMIN_OTP_WINDOW_MS, now + ADMIN_OTP_MAX, store);
    expect(r.limited).toBe(true);
  });
});

describe("admin-otp bucket — restart simulation (P3-3)", () => {
  beforeEach(() => {
    // Clear the global store before each test.
    getApiRateLimitStore().delete(ADMIN_OTP_RATE_KEY);
  });

  it("getAdminOtpBucket returns empty array when no attempts made", () => {
    const bucket = getAdminOtpBucket();
    expect(bucket).toEqual([]);
  });

  it("setAdminOtpBucket restores the bucket across restart", () => {
    const now = Date.now();
    // Simulate ADMIN_OTP_MAX - 1 attempts, all within the window.
    const timestamps = Array.from({ length: ADMIN_OTP_MAX - 1 }, (_, i) => now - i * 1000);
    setAdminOtpBucket(timestamps);

    const restored = getAdminOtpBucket();
    expect(restored.length).toBe(ADMIN_OTP_MAX - 1);
  });

  it("bucket restored from DB still blocks after reaching limit", () => {
    const now = Date.now();
    // Pre-fill with ADMIN_OTP_MAX attempts (simulating loaded-from-DB bucket).
    const timestamps = Array.from({ length: ADMIN_OTP_MAX }, (_, i) => now - i * 100);
    setAdminOtpBucket(timestamps);

    // Next attempt must be blocked.
    const r = checkApiLimit(ADMIN_OTP_RATE_KEY, ADMIN_OTP_MAX, ADMIN_OTP_WINDOW_MS, now + 1, getApiRateLimitStore());
    expect(r.limited).toBe(true);
  });

  it("bucket restored with expired timestamps does not block", () => {
    const now = Date.now();
    // All timestamps are outside the window.
    const expired = Array.from({ length: ADMIN_OTP_MAX }, (_, i) => now - ADMIN_OTP_WINDOW_MS - 1000 - i);
    setAdminOtpBucket(expired);

    const r = checkApiLimit(ADMIN_OTP_RATE_KEY, ADMIN_OTP_MAX, ADMIN_OTP_WINDOW_MS, now, getApiRateLimitStore());
    expect(r.limited).toBe(false);
  });
});
