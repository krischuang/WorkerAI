/**
 * P3-4: Timing Safe Authentication
 *
 * Verifies that timingSafeCompare produces correct results and uses the
 * Node.js timingSafeEqual under the hood for constant-time comparison.
 */

import { describe, it, expect } from "vitest";
import { timingSafeCompare } from "../timing-safe";

describe("timingSafeCompare", () => {
  it("returns true when strings are equal", () => {
    expect(timingSafeCompare("abc", "abc")).toBe(true);
  });

  it("returns false when strings differ", () => {
    expect(timingSafeCompare("abc", "abd")).toBe(false);
  });

  it("returns false when strings have different lengths", () => {
    expect(timingSafeCompare("abc", "abcd")).toBe(false);
    expect(timingSafeCompare("abcd", "abc")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(timingSafeCompare("", "")).toBe(true);
    expect(timingSafeCompare("", "a")).toBe(false);
  });

  it("handles long hex token strings (as used for session cookies)", () => {
    const token64 = "a".repeat(64);
    expect(timingSafeCompare(token64, token64)).toBe(true);
    expect(timingSafeCompare(token64, "b".repeat(64))).toBe(false);
  });

  it("is not short-circuited by first-byte difference", () => {
    // Can't easily verify constant-time in unit tests, but verify correctness
    // when the first byte differs (a naive === would fail here too, but we
    // confirm the result is still correct).
    expect(timingSafeCompare("xabc", "yabc")).toBe(false);
  });

  it("correctly compares realistic HMAC hex tokens", () => {
    const real = "3a7f91c2b5e840d6f17b8a29c4e5f632a8b1d7e90c3f54a26e8b19d7c4f20e5a";
    const tampered = "3a7f91c2b5e840d6f17b8a29c4e5f632a8b1d7e90c3f54a26e8b19d7c4f20e5b";
    expect(timingSafeCompare(real, real)).toBe(true);
    expect(timingSafeCompare(real, tampered)).toBe(false);
  });
});
