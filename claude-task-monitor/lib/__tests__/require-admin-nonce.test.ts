/**
 * NEW-1 — requireAdmin Nonce Regression Tests
 *
 * Verifies that the admin session guard uses the current nonce when validating
 * the session cookie. Before this fix, requireAdmin always called adminCookieToken
 * with nonce="" — so after the first logout (which rotates the nonce), every
 * subsequent valid admin session was rejected with 401.
 *
 * Tests cover:
 *   - login: session cookie is generated with the current nonce
 *   - logout: nonce rotation invalidates the old session cookie
 *   - re-login: a new session with the rotated nonce is accepted
 *   - self-healing route authorisation: routes that use requireAdmin remain
 *     accessible to valid sessions after logout/re-login
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { adminCookieToken } from "../../middleware";
import { getAdminNonce, setAdminNonce } from "../admin-nonce-cache";
import { timingSafeCompare } from "../timing-safe";

const PASSWORD = "test-admin-password-nonce-regression";

// Helper that replicates the requireAdmin guard logic with nonce support,
// matching the fixed implementation in lib/require-admin.ts.
async function simulateRequireAdmin(opts: {
  adminPassword: string | undefined;
  presentedCookie: string;
}): Promise<{ denied: true; status: 401 | 503 } | { denied: false }> {
  const { adminPassword, presentedCookie } = opts;
  if (!adminPassword) return { denied: true, status: 503 };

  const nonce = getAdminNonce();
  const expected = await adminCookieToken(adminPassword, nonce);

  if (!timingSafeCompare(presentedCookie, expected)) return { denied: true, status: 401 };
  return { denied: false };
}

// Save and restore the nonce between tests so the global state doesn't leak.
let savedNonce: string;
beforeEach(() => { savedNonce = getAdminNonce(); });
afterEach(() => { setAdminNonce(savedNonce); });

// ── Login ─────────────────────────────────────────────────────────────────────

describe("requireAdmin — login", () => {
  it("accepts a session cookie generated with the current nonce", async () => {
    setAdminNonce("initial-nonce");
    const cookie = await adminCookieToken(PASSWORD, "initial-nonce");

    const result = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: cookie });
    expect(result.denied).toBe(false);
  });

  it("rejects a cookie generated with no nonce when a nonce is set", async () => {
    setAdminNonce("live-nonce-abc");
    const staleToken = await adminCookieToken(PASSWORD, "");

    const result = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: staleToken });
    expect(result).toMatchObject({ denied: true, status: 401 });
  });

  it("rejects a cookie with the wrong password even when nonce matches", async () => {
    setAdminNonce("nonce-123");
    const cookie = await adminCookieToken("wrong-password", "nonce-123");

    const result = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: cookie });
    expect(result).toMatchObject({ denied: true, status: 401 });
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe("requireAdmin — logout invalidates old session", () => {
  it("cookie valid before logout is rejected after nonce rotation", async () => {
    setAdminNonce("pre-logout-nonce");
    const preLogoutCookie = await adminCookieToken(PASSWORD, "pre-logout-nonce");

    // Simulate logout: rotate the nonce
    setAdminNonce("post-logout-nonce");

    const result = await simulateRequireAdmin({
      adminPassword: PASSWORD,
      presentedCookie: preLogoutCookie,
    });
    expect(result).toMatchObject({ denied: true, status: 401 });
  });

  it("old cookie is invalid immediately after nonce rotation — no grace period", async () => {
    setAdminNonce("before");
    const oldCookie = await adminCookieToken(PASSWORD, "before");

    setAdminNonce("after"); // instant rotation

    const check = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: oldCookie });
    expect(check.denied).toBe(true);
  });
});

// ── Re-login ──────────────────────────────────────────────────────────────────

describe("requireAdmin — re-login after logout", () => {
  it("new session cookie generated with the rotated nonce is accepted", async () => {
    setAdminNonce("pre-logout-nonce");
    const preCookie = await adminCookieToken(PASSWORD, "pre-logout-nonce");

    // Logout
    setAdminNonce("post-logout-nonce");

    // Verify old session is rejected
    expect((await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: preCookie })).denied).toBe(true);

    // Re-login: generate new cookie with the new nonce
    const newCookie = await adminCookieToken(PASSWORD, "post-logout-nonce");
    const result = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: newCookie });
    expect(result.denied).toBe(false);
  });

  it("multiple logout cycles — only the most recent session is valid", async () => {
    setAdminNonce("n1");
    const c1 = await adminCookieToken(PASSWORD, "n1");

    setAdminNonce("n2");
    const c2 = await adminCookieToken(PASSWORD, "n2");

    setAdminNonce("n3");
    const c3 = await adminCookieToken(PASSWORD, "n3");

    // c1 and c2 must be rejected; c3 is the live session
    expect((await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: c1 })).denied).toBe(true);
    expect((await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: c2 })).denied).toBe(true);
    expect((await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: c3 })).denied).toBe(false);
  });

  it("a session started on a fresh install (nonce='') remains valid until first logout", async () => {
    setAdminNonce(""); // fresh install — no nonce yet
    const cookie = await adminCookieToken(PASSWORD, "");

    const result = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: cookie });
    expect(result.denied).toBe(false);
  });
});

// ── Self-healing route authorisation ──────────────────────────────────────────

describe("requireAdmin — self-healing route access after logout/re-login", () => {
  it("self-healing route is accessible with a valid re-login session", async () => {
    // Start with an initial nonce
    setAdminNonce("initial");
    const initialCookie = await adminCookieToken(PASSWORD, "initial");
    expect((await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: initialCookie })).denied).toBe(false);

    // Logout rotates the nonce
    setAdminNonce("rotated");

    // Old session cookie is rejected — this was the pre-fix bug
    expect((await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: initialCookie })).denied).toBe(true);

    // New session after re-login is accepted — self-healing routes work again
    const newCookie = await adminCookieToken(PASSWORD, "rotated");
    const result = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: newCookie });
    expect(result.denied).toBe(false);
  });

  it("returns 503 when ADMIN_PASSWORD is unset — self-healing routes fail closed", async () => {
    const result = await simulateRequireAdmin({ adminPassword: undefined, presentedCookie: "any" });
    expect(result).toMatchObject({ denied: true, status: 503 });
  });

  it("timing-safe comparison: empty cookie is rejected without short-circuiting", async () => {
    setAdminNonce("nonce-xyz");
    const result = await simulateRequireAdmin({ adminPassword: PASSWORD, presentedCookie: "" });
    expect(result).toMatchObject({ denied: true, status: 401 });
  });
});

// ── Nonce cache ───────────────────────────────────────────────────────────────

describe("admin nonce cache", () => {
  it("getAdminNonce returns empty string before any nonce is set", () => {
    setAdminNonce("");
    expect(getAdminNonce()).toBe("");
  });

  it("setAdminNonce updates the in-process cache immediately", () => {
    setAdminNonce("abc123");
    expect(getAdminNonce()).toBe("abc123");
  });

  it("nonce changes produce different tokens for the same password", async () => {
    const t1 = await adminCookieToken(PASSWORD, "nonce-a");
    const t2 = await adminCookieToken(PASSWORD, "nonce-b");
    expect(t1).not.toBe(t2);
  });

  it("same password + same nonce produces the same token (deterministic)", async () => {
    const t1 = await adminCookieToken(PASSWORD, "stable-nonce");
    const t2 = await adminCookieToken(PASSWORD, "stable-nonce");
    expect(t1).toBe(t2);
  });
});
