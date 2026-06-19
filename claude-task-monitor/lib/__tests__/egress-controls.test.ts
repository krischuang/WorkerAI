import { describe, it, expect, vi } from "vitest";
import { checkEgress, checkEgressBatch } from "../egress-controls";

// Mock audit + prisma to avoid DB calls
vi.mock("../audit", () => ({ emitAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../prisma", () => ({
  prisma: {
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Allowlist ──────────────────────────────────────────────────────────────────

describe("egress controls — default allowlist", () => {
  it("allows github.com", async () => {
    const result = await checkEgress({ url: "https://github.com/owner/repo" });
    expect(result.allowed).toBe(true);
    expect(result.decision).toBe("allow");
  });

  it("allows api.github.com", async () => {
    const result = await checkEgress({ url: "https://api.github.com/repos/owner/repo" });
    expect(result.allowed).toBe(true);
  });

  it("allows api.anthropic.com", async () => {
    const result = await checkEgress({ url: "https://api.anthropic.com/v1/messages" });
    expect(result.allowed).toBe(true);
  });

  it("allows openrouter.ai", async () => {
    const result = await checkEgress({ url: "https://openrouter.ai/api/v1/chat" });
    expect(result.allowed).toBe(true);
  });

  it("allows registry.npmjs.org", async () => {
    const result = await checkEgress({ url: "https://registry.npmjs.org/some-package" });
    expect(result.allowed).toBe(true);
  });
});

// ── Denylist — private IPs (SSRF prevention) ──────────────────────────────────

describe("egress controls — private IP SSRF prevention", () => {
  it("blocks localhost", async () => {
    const result = await checkEgress({ url: "http://localhost:8080/admin" });
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("deny");
  });

  it("blocks 127.0.0.1", async () => {
    const result = await checkEgress({ url: "http://127.0.0.1/secrets" });
    expect(result.allowed).toBe(false);
  });

  it("blocks 10.x.x.x (RFC 1918)", async () => {
    const result = await checkEgress({ url: "http://10.0.0.1/metadata" });
    expect(result.allowed).toBe(false);
  });

  it("blocks 192.168.x.x (RFC 1918)", async () => {
    const result = await checkEgress({ url: "http://192.168.1.1/admin" });
    expect(result.allowed).toBe(false);
  });

  it("blocks 172.16.x.x (RFC 1918)", async () => {
    const result = await checkEgress({ url: "http://172.16.0.1/internal" });
    expect(result.allowed).toBe(false);
  });

  it("blocks AWS metadata service 169.254.169.254", async () => {
    const result = await checkEgress({ url: "http://169.254.169.254/latest/meta-data/iam" });
    expect(result.allowed).toBe(false);
  });
});

// ── Default deny for unknown domains ──────────────────────────────────────────

describe("egress controls — default deny unknown domains", () => {
  it("blocks an arbitrary unknown domain", async () => {
    const result = await checkEgress({ url: "https://attacker.com/exfiltrate" });
    expect(result.allowed).toBe(false);
  });

  it("blocks a random IP", async () => {
    const result = await checkEgress({ url: "http://203.0.113.1/cmd" });
    expect(result.allowed).toBe(false);
  });

  it("blocks a subdomain of an allowed host that is not explicitly listed", async () => {
    const result = await checkEgress({ url: "https://evil.github.com.attacker.com/steal" });
    expect(result.allowed).toBe(false);
  });
});

// ── Malformed URLs ─────────────────────────────────────────────────────────────

describe("egress controls — malformed URLs are blocked", () => {
  it("blocks a non-URL string", async () => {
    const result = await checkEgress({ url: "not-a-url" });
    // Bare hostname without protocol gets https:// prepended — 'not-a-url' doesn't resolve to a known host
    expect(result.allowed).toBe(false);
  });
});

// ── Batch check ───────────────────────────────────────────────────────────────

describe("egress controls — batch check", () => {
  it("returns allAllowed=true when all URLs are in the allowlist", async () => {
    const result = await checkEgressBatch({
      urls: ["https://github.com/repo", "https://api.anthropic.com/v1"],
    });
    expect(result.allAllowed).toBe(true);
    expect(result.blocked).toHaveLength(0);
  });

  it("returns allAllowed=false when any URL is blocked", async () => {
    const result = await checkEgressBatch({
      urls: ["https://github.com/repo", "https://attacker.com/steal"],
    });
    expect(result.allAllowed).toBe(false);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].host).toBe("attacker.com");
  });
});
