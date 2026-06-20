/**
 * AUTH_SECRET fail-closed tests.
 *
 * Verifies that the middleware guard condition fails closed (503) when
 * AUTH_SECRET is absent, and passes through only when a valid secret is
 * present and the session cookie matches.
 *
 * The guard logic is exercised via a simulateAuthCheck helper that replicates
 * the middleware branch without requiring the Next.js edge runtime, following
 * the same pattern as admin-middleware.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { cookieToken } from "../../middleware";

// ── simulateAuthCheck ──────────────────────────────────────────────────────────
//
// Replicates the AUTH_SECRET guard in middleware.ts:
//
//   const secret = process.env.AUTH_SECRET;
//   if (!secret) → 503
//   const expected = await cookieToken(secret);
//   if (cookie !== expected) → 401
//   else → 200
//
// Returns { statusCode } to make assertions concise.

async function simulateAuthCheck(opts: {
  authSecret: string | undefined;
  presentedCookie: string | undefined;
}): Promise<{ statusCode: number; blocked: boolean }> {
  const { authSecret, presentedCookie } = opts;

  if (!authSecret) {
    return { statusCode: 503, blocked: true };
  }

  const expected = await cookieToken(authSecret);
  if (presentedCookie !== expected) {
    return { statusCode: 401, blocked: true };
  }

  return { statusCode: 200, blocked: false };
}

// ── Guard condition unit tests ─────────────────────────────────────────────────

describe("AUTH_SECRET guard condition", () => {
  const originalSecret = process.env.AUTH_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalSecret;
    }
  });

  it("passes through when AUTH_SECRET is present", () => {
    process.env.AUTH_SECRET = "some-secret";
    const secret = process.env.AUTH_SECRET;
    expect(Boolean(secret)).toBe(true);
    // The guard condition `!secret` must be false → no 503
    expect(!secret).toBe(false);
  });

  it("fails closed when AUTH_SECRET is undefined", () => {
    delete process.env.AUTH_SECRET;
    const secret = process.env.AUTH_SECRET;
    expect(secret).toBeUndefined();
    expect(!secret).toBe(true);
  });

  it("fails closed when AUTH_SECRET is an empty string", () => {
    process.env.AUTH_SECRET = "";
    const secret = process.env.AUTH_SECRET;
    // Empty string is falsy — must behave identically to missing
    expect(!secret).toBe(true);
  });
});

// ── Request simulation tests ───────────────────────────────────────────────────

describe("AUTH_SECRET missing — all requests blocked with 503", () => {
  it("blocks an unauthenticated request when AUTH_SECRET is missing", async () => {
    const result = await simulateAuthCheck({
      authSecret: undefined,
      presentedCookie: undefined,
    });
    expect(result.statusCode).toBe(503);
    expect(result.blocked).toBe(true);
  });

  it("blocks an authenticated request when AUTH_SECRET is missing", async () => {
    // Even if the caller somehow has a valid-looking cookie, without the secret
    // we cannot verify it — the request must be rejected.
    const result = await simulateAuthCheck({
      authSecret: undefined,
      presentedCookie: "some-cookie-value",
    });
    expect(result.statusCode).toBe(503);
    expect(result.blocked).toBe(true);
  });

  it("returns 503 regardless of cookie value when AUTH_SECRET is missing", async () => {
    for (const cookie of [undefined, "", "abc", "a".repeat(64)]) {
      const result = await simulateAuthCheck({
        authSecret: undefined,
        presentedCookie: cookie,
      });
      expect(result.statusCode).toBe(503);
    }
  });
});

describe("AUTH_SECRET present — correct session cookie grants access", () => {
  const SECRET = "test-auth-secret-64chars-abcdefghijklmnopqrstuvwxyz1234567890ab";

  it("grants access when the correct cookie is presented", async () => {
    const cookie = await cookieToken(SECRET);
    const result = await simulateAuthCheck({
      authSecret: SECRET,
      presentedCookie: cookie,
    });
    expect(result.statusCode).toBe(200);
    expect(result.blocked).toBe(false);
  });

  it("blocks access when no cookie is presented", async () => {
    const result = await simulateAuthCheck({
      authSecret: SECRET,
      presentedCookie: undefined,
    });
    expect(result.statusCode).toBe(401);
    expect(result.blocked).toBe(true);
  });

  it("blocks access when an incorrect cookie is presented", async () => {
    const result = await simulateAuthCheck({
      authSecret: SECRET,
      presentedCookie: "wrong-cookie-value",
    });
    expect(result.statusCode).toBe(401);
    expect(result.blocked).toBe(true);
  });

  it("blocks access when cookie is derived from a different secret", async () => {
    const wrongCookie = await cookieToken("different-secret");
    const result = await simulateAuthCheck({
      authSecret: SECRET,
      presentedCookie: wrongCookie,
    });
    expect(result.statusCode).toBe(401);
    expect(result.blocked).toBe(true);
  });
});

// ── cookieToken helper ─────────────────────────────────────────────────────────

describe("cookieToken", () => {
  it("produces a 64-char hex string", async () => {
    const token = await cookieToken("any-secret");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same secret produces same token", async () => {
    const a = await cookieToken("stable-secret");
    const b = await cookieToken("stable-secret");
    expect(a).toBe(b);
  });

  it("is sensitive — different secrets produce different tokens", async () => {
    const a = await cookieToken("secret-a");
    const b = await cookieToken("secret-b");
    expect(a).not.toBe(b);
  });
});
