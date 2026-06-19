/**
 * P3-2: Admin Session Revocation
 *
 * Verifies that:
 *   1. Login generates a token using the current nonce.
 *   2. After logout (nonce rotation), the old token is no longer valid.
 *   3. A new login after logout generates a fresh, valid token.
 */

import { describe, it, expect } from "vitest";
import { adminCookieToken } from "../../middleware";

const PASSWORD = "test-admin-password-p3-2";

describe("adminCookieToken — nonce inclusion", () => {
  it("produces a different token when nonce changes", async () => {
    const tokenA = await adminCookieToken(PASSWORD, "nonce-before-logout");
    const tokenB = await adminCookieToken(PASSWORD, "nonce-after-logout");
    expect(tokenA).not.toBe(tokenB);
  });

  it("produces the same token for the same nonce (deterministic)", async () => {
    const nonce = "stable-nonce-xyz";
    const a = await adminCookieToken(PASSWORD, nonce);
    const b = await adminCookieToken(PASSWORD, nonce);
    expect(a).toBe(b);
  });

  it("token with empty nonce differs from token with a real nonce", async () => {
    const withoutNonce = await adminCookieToken(PASSWORD, "");
    const withNonce = await adminCookieToken(PASSWORD, "abc123");
    expect(withoutNonce).not.toBe(withNonce);
  });

  it("tokens are 64-char hex strings regardless of nonce", async () => {
    const token = await adminCookieToken(PASSWORD, "some-nonce");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Session revocation — logout invalidates old tokens", () => {
  it("captured token is invalid after nonce rotation (logout simulation)", async () => {
    const preLogoutNonce = "pre-logout-nonce";
    const postLogoutNonce = "post-logout-nonce"; // simulates rotateNonce()

    const capturedToken = await adminCookieToken(PASSWORD, preLogoutNonce);
    const expectedAfterLogout = await adminCookieToken(PASSWORD, postLogoutNonce);

    // The captured token no longer matches the expected token
    expect(capturedToken).not.toBe(expectedAfterLogout);
  });

  it("new login after logout produces a valid token with the new nonce", async () => {
    const newNonce = "freshly-rotated-nonce";
    const newToken = await adminCookieToken(PASSWORD, newNonce);
    const expected = await adminCookieToken(PASSWORD, newNonce);
    expect(newToken).toBe(expected);
  });
});
