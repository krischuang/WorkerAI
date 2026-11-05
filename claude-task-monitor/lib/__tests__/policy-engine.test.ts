/**
 * Tests for lib/policy-engine.ts, focused on the matchGlob bug found while
 * building the Demo Day E2E scenario: a double-star-slash glob prefix left
 * the slash as a literal required character, so a bare root-level .env file
 * slipped past the "block secret files" rule while a nested one was
 * correctly denied.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    systemConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  emitAudit: vi.fn().mockResolvedValue(undefined),
}));

import {
  evaluatePolicy,
  evaluateDispatchPolicy,
  grantPolicyApproval,
  getPolicyApproval,
  consumePolicyApproval,
} from "../policy-engine";
import { prisma } from "@/lib/prisma";

const mockSystemConfig = vi.mocked(prisma.systemConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockSystemConfig.findUnique.mockResolvedValue(null);
  mockSystemConfig.upsert.mockResolvedValue({} as never);
  mockSystemConfig.delete.mockResolvedValue({} as never);
});

describe("policy engine — secret file glob matching", () => {
  it("denies a nested secret file (regression baseline)", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: ["backend/.env"],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.id).toBe("builtin:deny-secret-files");
  });

  it("denies a bare root-level .env — the most common, most sensitive location", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: [".env"],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.id).toBe("builtin:deny-secret-files");
  });

  it("denies a bare root-level secrets directory entry", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: ["secrets/prod.key"],
    });
    expect(result.decision).toBe("deny");
  });

  // Conventional OpenSSH private key filenames have no extension — *.key and
  // *.pem alone miss every one of these. Found during the Demo Day security
  // pass.
  it.each([
    "id_rsa",
    ".ssh/id_rsa",
    "id_ed25519",
    "home/user/.ssh/id_ecdsa",
  ])("denies conventional SSH private key path %s", async (filePath) => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: [filePath],
    });
    expect(result.decision).toBe("deny");
  });

  it.each([
    ".aws/credentials",
    ".netrc",
    ".npmrc",
    ".docker/config.json",
    ".kube/config",
  ])("denies common cloud-credential path %s", async (filePath) => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: [filePath],
    });
    expect(result.decision).toBe("deny");
  });

  it("requires approval for a bare root-level middleware.ts (auth code)", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: ["middleware.ts"],
    });
    expect(result.decision).toBe("require_approval");
    expect(result.matchedRule?.id).toBe("builtin:approve-auth-code");
  });

  it("still allows an unrelated root-level file", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: ["index.ts"],
      riskLevel: "low",
    });
    expect(result.decision).toBe("allow");
  });
});

describe("policy engine — evaluateDispatchPolicy", () => {
  it("surfaces a deny from a file-change rule as blocked", async () => {
    const result = await evaluateDispatchPolicy({
      taskId: "t1",
      filePaths: [".env"],
    });
    expect(result.blocked).toBe(true);
    expect(result.decision).toBe("deny");
  });

  it("does not block a benign dispatch with no risky file paths", async () => {
    const result = await evaluateDispatchPolicy({
      taskId: "t1",
      riskLevel: "low",
    });
    expect(result.blocked).toBe(false);
    expect(result.decision).toBe("allow");
  });
});

describe("policy engine — approval grant/get/consume (SystemConfig-backed, no schema change)", () => {
  it("returns null when no approval has been granted", async () => {
    const approval = await getPolicyApproval("t1", "code_execution");
    expect(approval).toBeNull();
    expect(mockSystemConfig.findUnique).toHaveBeenCalledWith({ where: { key: "policy_approval:t1" } });
  });

  it("round-trips a granted approval through get, for the same category", async () => {
    await grantPolicyApproval({ taskId: "t1", approvedBy: "admin", category: "code_execution", detail: "looks fine" });

    // Pull the exact value grantPolicyApproval wrote and feed it back through
    // findUnique, so getPolicyApproval parses real JSON it produced — not a
    // hand-written fixture that could drift from the real shape.
    const upsertCall = mockSystemConfig.upsert.mock.calls[0][0] as unknown as { create: { value: string } };
    mockSystemConfig.findUnique.mockResolvedValueOnce({ value: upsertCall.create.value } as never);

    const approval = await getPolicyApproval("t1", "code_execution");

    expect(approval).not.toBeNull();
    expect(approval?.approvedBy).toBe("admin");
    expect(approval?.detail).toBe("looks fine");
    expect(approval?.category).toBe("code_execution");
    expect(typeof approval?.approvedAt).toBe("string");
    expect(typeof approval?.expiresAt).toBe("string");
  });

  it("SECURITY: an approval granted for one category cannot be reused for a different category on the same task", async () => {
    await grantPolicyApproval({ taskId: "t1", approvedBy: "admin", category: "code_execution" });
    const upsertCall = mockSystemConfig.upsert.mock.calls[0][0] as unknown as { create: { value: string } };
    mockSystemConfig.findUnique.mockResolvedValue({ value: upsertCall.create.value } as never);

    // Same task, same stored record — but asking for a DIFFERENT category
    // (as the file-level gate would) must not see it as valid.
    const approval = await getPolicyApproval("t1", "file_change");
    expect(approval).toBeNull();
  });

  it("SECURITY: an expired approval is treated as absent and is removed", async () => {
    const expired = {
      approvedBy: "admin",
      approvedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // 1s in the past
      category: "code_execution",
    };
    mockSystemConfig.findUnique.mockResolvedValue({ value: JSON.stringify(expired) } as never);

    const approval = await getPolicyApproval("t1", "code_execution");

    expect(approval).toBeNull();
    // Expired approvals are deleted on read, not left to linger.
    expect(mockSystemConfig.delete).toHaveBeenCalledWith({ where: { key: "policy_approval:t1" } });
  });

  it("caps an excessive requested TTL at the hard ceiling (4 hours)", async () => {
    await grantPolicyApproval({ taskId: "t1", approvedBy: "admin", category: "code_execution", ttlMinutes: 999999 });
    const upsertCall = mockSystemConfig.upsert.mock.calls[0][0] as unknown as { create: { value: string } };
    const stored = JSON.parse(upsertCall.create.value) as { approvedAt: string; expiresAt: string };
    const ttlMs = new Date(stored.expiresAt).getTime() - new Date(stored.approvedAt).getTime();
    expect(ttlMs).toBeLessThanOrEqual(240 * 60_000 + 1000); // allow 1s of test jitter
  });

  it("consume deletes the stored approval", async () => {
    await consumePolicyApproval("t1");
    expect(mockSystemConfig.delete).toHaveBeenCalledWith({ where: { key: "policy_approval:t1" } });
  });

  it("consume does not throw when no approval exists", async () => {
    mockSystemConfig.delete.mockRejectedValue(new Error("not found"));
    await expect(consumePolicyApproval("t1")).resolves.toBeUndefined();
  });
});

describe("policy engine — adversarial path inputs", () => {
  it("SECURITY: denies .env reached through a traversal-looking relative path", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: ["subdir/../.env"],
    });
    // Node's own path semantics aren't applied here — matchGlob is a plain
    // string/regex match against whatever path string the caller supplies
    // (in practice, whatever `git status` prints, which never emits raw ".."
    // segments). This documents the actual, current behavior for a
    // non-normalized path rather than assuming normalization that doesn't
    // happen: the literal string "subdir/../.env" does still end in
    // "/.env", which the **/.env pattern matches.
    expect(result.decision).toBe("deny");
  });

  it("SECURITY: denies a nested secrets directory reached via a long traversal chain", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: ["a/b/c/../../../secrets/prod.key"],
    });
    expect(result.decision).toBe("deny");
  });

  it("does not crash or misbehave on a path containing shell metacharacters", async () => {
    const result = await evaluatePolicy({
      taskId: "t1",
      category: "file_change",
      filePaths: ["$(rm -rf /)/.env"],
    });
    // The path is only ever used for string/regex matching here — never
    // passed to a shell (that boundary is enforced separately, see
    // lib/validation-gate.ts's posixQuote usage and the injection-safety
    // tests in lib/__tests__/validation-gate.test.ts). We only require this
    // doesn't throw and still recognizes the embedded ".env".
    expect(() => result).not.toThrow();
    expect(result.decision).toBe("deny");
  });
});
