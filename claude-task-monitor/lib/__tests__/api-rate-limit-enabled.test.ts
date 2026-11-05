/**
 * Tests for lib/api-rate-limit.ts's isRateLimitEnabled/setRateLimitEnabled.
 *
 * Found during the Demo Day CI reliability pass: isRateLimitEnabled() is
 * only ever called from middleware.ts, which runs in the Edge Runtime (a
 * separate V8 isolate from the Node.js runtime). setRateLimitEnabled() is
 * only ever called from Node.js-runtime code (instrumentation.node.ts, the
 * admin config route). globalThis is not shared between the two runtimes, so
 * the SystemConfig-backed admin toggle could never actually take effect —
 * confirmed by direct reproduction (a live burst-request test against a real
 * dev server) while building this fix. The real, working mechanism is the
 * RATE_LIMIT_DISABLED env var, mirroring PLATFORM_KILL_SWITCH's pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isRateLimitEnabled, setRateLimitEnabled } from "../api-rate-limit";

beforeEach(() => {
  delete process.env.RATE_LIMIT_DISABLED;
});

afterEach(() => {
  delete process.env.RATE_LIMIT_DISABLED;
  setRateLimitEnabled(true); // restore default so other test files aren't affected
});

describe("isRateLimitEnabled — env var fast path (the only path middleware.ts's Edge Runtime can see)", () => {
  it("is enabled by default", () => {
    expect(isRateLimitEnabled()).toBe(true);
  });

  it("SECURITY/RELIABILITY: RATE_LIMIT_DISABLED=1 disables it", () => {
    process.env.RATE_LIMIT_DISABLED = "1";
    expect(isRateLimitEnabled()).toBe(false);
  });

  it("RATE_LIMIT_DISABLED=true (case-insensitive) disables it", () => {
    process.env.RATE_LIMIT_DISABLED = "True";
    expect(isRateLimitEnabled()).toBe(false);
  });

  it("an unrelated value does not disable it", () => {
    process.env.RATE_LIMIT_DISABLED = "nope";
    expect(isRateLimitEnabled()).toBe(true);
  });

  it("the env var takes precedence over the globalThis cache", () => {
    setRateLimitEnabled(true);
    process.env.RATE_LIMIT_DISABLED = "1";
    expect(isRateLimitEnabled()).toBe(false);
  });

  it("still respects the globalThis cache when no env var is set (kept for any future Node.js-runtime caller)", () => {
    setRateLimitEnabled(false);
    expect(isRateLimitEnabled()).toBe(false);
  });
});
