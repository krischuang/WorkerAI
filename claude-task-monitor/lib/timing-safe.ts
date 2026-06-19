/**
 * Timing-safe string comparison utilities.
 *
 * Using `===` for security-sensitive comparisons (session tokens, HMAC
 * signatures, API keys) leaks timing information that can help an attacker
 * enumerate valid prefixes.  Always use timingSafeCompare() for these.
 *
 * Works in both Node.js and Edge runtimes:
 *   – Node.js: uses crypto.timingSafeEqual (constant-time byte comparison)
 *   – Edge / browser: falls back to a constant-time XOR loop implemented
 *     with Web Crypto encode/decode (no Node.js built-in required)
 */

// We try to import Node.js crypto lazily so the module is importable in
// edge contexts where the static import would fail.
function nodeTimingSafeEqual(a: string, b: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { timingSafeEqual, createHash } = require("crypto") as typeof import("crypto");
    // Always compare fixed-length representations to prevent length leakage.
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

/** Constant-time fallback using the Web Crypto API (XOR on UTF-8 bytes). */
function webCryptoTimingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  // Always iterate over the longer buffer to avoid early-exit on length mismatch.
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Timing-safe string equality check.
 *
 * Uses Node.js `crypto.timingSafeEqual` where available (fastest, most
 * reliable); falls back to a Web Crypto XOR loop otherwise.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof require !== "undefined") {
    return nodeTimingSafeEqual(a, b);
  }
  return webCryptoTimingSafeEqual(a, b);
}
