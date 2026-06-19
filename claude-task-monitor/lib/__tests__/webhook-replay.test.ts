/**
 * P3-9: Webhook Replay Protection
 *
 * Verifies that:
 *   1. signWebhookPayload produces timestamp-based signatures.
 *   2. verifyWebhookSignature accepts valid, fresh signatures.
 *   3. Expired signatures are rejected (>5 min old).
 *   4. Tampered signatures are rejected.
 *   5. Future timestamps are rejected.
 *   6. Malformed headers are rejected.
 */

import { describe, it, expect } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "../notification";

const SECRET = "test-webhook-secret-abc123";
const BODY = JSON.stringify({ event: "task.completed", taskId: "test-123" });

describe("signWebhookPayload", () => {
  it("produces a header with t= and v1= parts", () => {
    const header = signWebhookPayload(BODY, SECRET);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  });

  it("timestamp is within a few seconds of now", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload(BODY, SECRET);
    const tMatch = header.match(/t=(\d+)/);
    const t = parseInt(tMatch![1], 10);
    expect(Math.abs(t - nowSec)).toBeLessThan(5);
  });

  it("different bodies produce different signatures", () => {
    const nowMs = Date.now();
    const h1 = signWebhookPayload(BODY, SECRET, nowMs);
    const h2 = signWebhookPayload(BODY + "x", SECRET, nowMs);
    expect(h1).not.toBe(h2);
  });

  it("different secrets produce different signatures", () => {
    const nowMs = Date.now();
    const h1 = signWebhookPayload(BODY, "secret-a", nowMs);
    const h2 = signWebhookPayload(BODY, "secret-b", nowMs);
    expect(h1).not.toBe(h2);
  });
});

describe("verifyWebhookSignature — valid signatures", () => {
  it("accepts a freshly signed payload", () => {
    const nowMs = Date.now();
    const header = signWebhookPayload(BODY, SECRET, nowMs);
    const result = verifyWebhookSignature(header, BODY, SECRET, nowMs);
    expect(result.valid).toBe(true);
  });

  it("accepts a 4-minute-old signature (within 5-min window)", () => {
    const signedAtMs = Date.now() - 4 * 60 * 1000;
    const nowMs = Date.now();
    const header = signWebhookPayload(BODY, SECRET, signedAtMs);
    const result = verifyWebhookSignature(header, BODY, SECRET, nowMs);
    expect(result.valid).toBe(true);
  });
});

describe("verifyWebhookSignature — rejected signatures", () => {
  it("rejects a signature older than 5 minutes", () => {
    const signedAtMs = Date.now() - 6 * 60 * 1000; // 6 min ago
    const nowMs = Date.now();
    const header = signWebhookPayload(BODY, SECRET, signedAtMs);
    const result = verifyWebhookSignature(header, BODY, SECRET, nowMs);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("rejects a replayed signature at the exact 5-min boundary", () => {
    const signedAtMs = Date.now() - 5 * 60 * 1000 - 1; // just past the boundary
    const nowMs = Date.now();
    const header = signWebhookPayload(BODY, SECRET, signedAtMs);
    const result = verifyWebhookSignature(header, BODY, SECRET, nowMs);
    expect(result.valid).toBe(false);
  });

  it("rejects a signature with a future timestamp", () => {
    const signedAtMs = Date.now() + 60_000; // 1 min in the future
    const nowMs = Date.now();
    const header = signWebhookPayload(BODY, SECRET, signedAtMs);
    const result = verifyWebhookSignature(header, BODY, SECRET, nowMs);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("future");
  });

  it("rejects a tampered body", () => {
    const nowMs = Date.now();
    const header = signWebhookPayload(BODY, SECRET, nowMs);
    const result = verifyWebhookSignature(header, BODY + "tampered", SECRET, nowMs);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("mismatch");
  });

  it("rejects a tampered v1 signature", () => {
    const nowMs = Date.now();
    const header = signWebhookPayload(BODY, SECRET, nowMs);
    const tampered = header.replace(/v1=[0-9a-f]+/, "v1=" + "0".repeat(64));
    const result = verifyWebhookSignature(tampered, BODY, SECRET, nowMs);
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed header (no t= or v1=)", () => {
    const result = verifyWebhookSignature("sha256=abc123", BODY, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("malformed");
  });
});
